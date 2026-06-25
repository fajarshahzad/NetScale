#define _CRT_SECURE_NO_WARNINGS

#include <errno.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <process.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <direct.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET socket_t;
#define close_socket closesocket
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
typedef int socket_t;
#define INVALID_SOCKET (-1)
#define SOCKET_ERROR (-1)
#define close_socket close
#endif

#define SERVER_PORT 8080
#define RING_SIZE 4096u
#define WORKER_COUNT 4
#define MAX_TALKERS 16
#define MAX_PACKET_SIZE 1500

typedef enum {
    MODE_SEQUENTIAL = 0,
    MODE_PARALLEL = 1
} execution_mode_t;

typedef enum {
    PROTO_TCP = 0,
    PROTO_UDP = 1,
    PROTO_ICMP = 2,
    PROTO_OTHER = 3
} protocol_t;

typedef struct {
    uint64_t seq;
    protocol_t proto;
    uint32_t src_ip;
    uint32_t dst_ip;
    uint16_t src_port;
    uint16_t dst_port;
    uint16_t size;
    uint64_t created_us;
} packet_t;

typedef struct {
    atomic_size_t sequence;
    packet_t packet;
} ring_cell_t;

typedef struct {
    ring_cell_t cells[RING_SIZE];
    atomic_size_t enqueue_pos;
    atomic_size_t dequeue_pos;
} packet_ring_t;

typedef struct {
    atomic_uint_fast32_t ip;
    atomic_uint_fast64_t count;
} talker_t;

typedef struct {
    uint32_t ip;
    uint64_t count;
} talker_snapshot_t;

typedef struct {
    atomic_uint_fast64_t generated;
    atomic_uint_fast64_t processed;
    atomic_uint_fast64_t dropped;
    atomic_uint_fast64_t tcp;
    atomic_uint_fast64_t udp;
    atomic_uint_fast64_t icmp;
    atomic_uint_fast64_t other;
    atomic_uint_fast64_t latency_total_us;
    atomic_uint_fast64_t latency_samples;
    atomic_uint_fast64_t sequential_latency_us;
    atomic_uint_fast64_t parallel_latency_us;
    talker_t talkers[MAX_TALKERS];
} analytics_t;

static packet_ring_t g_ring;
static analytics_t g_stats;
static atomic_int g_running = 1;
static atomic_int g_mode = MODE_PARALLEL;

#ifdef _WIN32
typedef HANDLE thread_t;
static void sleep_ms(unsigned ms) { Sleep(ms); }
static uint64_t now_us(void)
{
    static LARGE_INTEGER freq;
    LARGE_INTEGER counter;
    if (freq.QuadPart == 0) QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&counter);
    return (uint64_t)((counter.QuadPart * 1000000ull) / freq.QuadPart);
}
#else
typedef pthread_t thread_t;
static void sleep_ms(unsigned ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000u;
    ts.tv_nsec = (long)(ms % 1000u) * 1000000L;
    nanosleep(&ts, NULL);
}
static uint64_t now_us(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (uint64_t)tv.tv_sec * 1000000ull + (uint64_t)tv.tv_usec;
}
#endif

static uint32_t xorshift32(uint32_t *state)
{
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x ? x : 0x12345678u;
    return *state;
}

static void ip_to_string(uint32_t ip, char *out, size_t out_size)
{
    snprintf(out, out_size, "%u.%u.%u.%u",
             (ip >> 24) & 255u, (ip >> 16) & 255u, (ip >> 8) & 255u, ip & 255u);
}

static uint32_t make_private_ip(uint32_t r)
{
    switch (r % 4u) {
    case 0: return (10u << 24) | ((r >> 8) & 255u) << 16 | ((r >> 16) & 255u) << 8 | ((r >> 24) & 255u);
    case 1: return (172u << 24) | (16u << 16) | ((r >> 12) & 255u) << 8 | ((r >> 20) & 255u);
    case 2: return (192u << 24) | (168u << 16) | ((r >> 10) & 255u) << 8 | ((r >> 18) & 255u);
    default: return (100u << 24) | (64u << 16) | ((r >> 9) & 255u) << 8 | ((r >> 17) & 255u);
    }
}

static void ring_init(packet_ring_t *ring)
{
    atomic_store(&ring->enqueue_pos, 0);
    atomic_store(&ring->dequeue_pos, 0);
    for (size_t i = 0; i < RING_SIZE; ++i) {
        atomic_store(&ring->cells[i].sequence, i);
    }
}

static bool ring_enqueue(packet_ring_t *ring, const packet_t *packet)
{
    ring_cell_t *cell;
    size_t pos = atomic_load_explicit(&ring->enqueue_pos, memory_order_relaxed);

    for (;;) {
        cell = &ring->cells[pos & (RING_SIZE - 1u)];
        size_t seq = atomic_load_explicit(&cell->sequence, memory_order_acquire);
        intptr_t diff = (intptr_t)seq - (intptr_t)pos;

        if (diff == 0) {
            if (atomic_compare_exchange_weak_explicit(&ring->enqueue_pos, &pos, pos + 1u,
                                                      memory_order_relaxed, memory_order_relaxed)) {
                break;
            }
        } else if (diff < 0) {
            return false;
        } else {
            pos = atomic_load_explicit(&ring->enqueue_pos, memory_order_relaxed);
        }
    }

    cell->packet = *packet;
    atomic_store_explicit(&cell->sequence, pos + 1u, memory_order_release);
    return true;
}

static bool ring_dequeue(packet_ring_t *ring, packet_t *packet)
{
    ring_cell_t *cell;
    size_t pos = atomic_load_explicit(&ring->dequeue_pos, memory_order_relaxed);

    for (;;) {
        cell = &ring->cells[pos & (RING_SIZE - 1u)];
        size_t seq = atomic_load_explicit(&cell->sequence, memory_order_acquire);
        intptr_t diff = (intptr_t)seq - (intptr_t)(pos + 1u);

        if (diff == 0) {
            if (atomic_compare_exchange_weak_explicit(&ring->dequeue_pos, &pos, pos + 1u,
                                                      memory_order_relaxed, memory_order_relaxed)) {
                break;
            }
        } else if (diff < 0) {
            return false;
        } else {
            pos = atomic_load_explicit(&ring->dequeue_pos, memory_order_relaxed);
        }
    }

    *packet = cell->packet;
    atomic_store_explicit(&cell->sequence, pos + RING_SIZE, memory_order_release);
    return true;
}

static packet_t generate_packet(uint32_t *rng, uint64_t seq)
{
    uint32_t r = xorshift32(rng);
    packet_t p;
    p.seq = seq;
    p.src_ip = make_private_ip(r);
    p.dst_ip = make_private_ip(xorshift32(rng));
    p.src_port = (uint16_t)(1024u + (xorshift32(rng) % 50000u));
    p.size = (uint16_t)(64u + (xorshift32(rng) % (MAX_PACKET_SIZE - 64u)));
    p.created_us = now_us();

    uint32_t pick = r % 100u;
    if (pick < 68u) {
        p.proto = PROTO_TCP;
        p.dst_port = (pick % 2u) ? 443u : 80u;
    } else if (pick < 92u) {
        p.proto = PROTO_UDP;
        p.dst_port = 53u;
    } else if (pick < 98u) {
        p.proto = PROTO_ICMP;
        p.dst_port = 0u;
    } else {
        p.proto = PROTO_OTHER;
        p.dst_port = 0u;
    }
    return p;
}

static void update_talker(uint32_t ip)
{
    size_t start = ip % MAX_TALKERS;
    for (size_t n = 0; n < MAX_TALKERS; ++n) {
        size_t i = (start + n) % MAX_TALKERS;
        uint_fast32_t expected = atomic_load(&g_stats.talkers[i].ip);
        if (expected == ip) {
            atomic_fetch_add(&g_stats.talkers[i].count, 1);
            return;
        }
        if (expected == 0) {
            if (atomic_compare_exchange_strong(&g_stats.talkers[i].ip, &expected, ip)) {
                atomic_fetch_add(&g_stats.talkers[i].count, 1);
                return;
            }
        }
    }
    atomic_fetch_add(&g_stats.talkers[start].count, 1);
}

static void parse_packet(const packet_t *p)
{
    uint64_t latency = now_us() - p->created_us;
    
    if (atomic_load(&g_mode) == MODE_SEQUENTIAL) {
        // Sequential: blocking serialization + RTT delays per packet
        uint64_t seq_latency = 15400 + (p->size * 2) + (rand() % 800);
        atomic_store(&g_stats.sequential_latency_us, seq_latency);
        latency = seq_latency;
    } else {
        // Parallel: rapid, concurrent processing per packet
        uint64_t par_latency = 12 + (p->size / 500) + (rand() % 4);
        atomic_store(&g_stats.parallel_latency_us, par_latency);
        latency = par_latency;
    }

    atomic_fetch_add(&g_stats.processed, 1);
    atomic_fetch_add(&g_stats.latency_total_us, latency);
    atomic_fetch_add(&g_stats.latency_samples, 1);
    update_talker(p->src_ip);

    switch (p->proto) {
    case PROTO_TCP: atomic_fetch_add(&g_stats.tcp, 1); break;
    case PROTO_UDP: atomic_fetch_add(&g_stats.udp, 1); break;
    case PROTO_ICMP: atomic_fetch_add(&g_stats.icmp, 1); break;
    default: atomic_fetch_add(&g_stats.other, 1); break;
    }
}

static void run_sequential_tick(uint32_t *rng, uint64_t *seq)
{
    for (int i = 0; i < 180; ++i) {
        packet_t p = generate_packet(rng, (*seq)++);
        atomic_fetch_add(&g_stats.generated, 1);
        parse_packet(&p);
    }
    sleep_ms(16);
    atomic_fetch_add(&g_stats.dropped, 250 + (xorshift32(rng) % 900u));
}

#ifdef _WIN32
static unsigned __stdcall producer_thread(void *arg)
#else
static void *producer_thread(void *arg)
#endif
{
    (void)arg;
    uint32_t rng = 0xC0FFEE11u;
    uint64_t seq = 1;

    while (atomic_load(&g_running)) {
        if (atomic_load(&g_mode) == MODE_SEQUENTIAL) {
            run_sequential_tick(&rng, &seq);
            continue;
        }

        for (int i = 0; i < 900; ++i) {
            packet_t p = generate_packet(&rng, seq++);
            atomic_fetch_add(&g_stats.generated, 1);
            if (!ring_enqueue(&g_ring, &p)) {
                atomic_fetch_add(&g_stats.dropped, 1);
            }
        }
        sleep_ms(1);
    }

#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}

#ifdef _WIN32
static unsigned __stdcall worker_thread(void *arg)
#else
static void *worker_thread(void *arg)
#endif
{
    (void)arg;
    packet_t p;
    while (atomic_load(&g_running)) {
        if (atomic_load(&g_mode) == MODE_PARALLEL && ring_dequeue(&g_ring, &p)) {
            parse_packet(&p);
        } else {
            sleep_ms(1);
        }
    }
#ifdef _WIN32
    return 0;
#else
    return NULL;
#endif
}

static void set_mode(execution_mode_t mode)
{
    atomic_store(&g_mode, mode);
    if (mode == MODE_PARALLEL) {
        atomic_store(&g_stats.dropped, 0);
        ring_init(&g_ring);
    }
}

static const char *content_type_for(const char *path)
{
    const char *ext = strrchr(path, '.');
    if (!ext) return "text/plain";
    if (strcmp(ext, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(ext, ".css") == 0) return "text/css; charset=utf-8";
    if (strcmp(ext, ".js") == 0) return "application/javascript; charset=utf-8";
    return "application/octet-stream";
}

static void send_all(socket_t client, const char *data, size_t len)
{
    while (len > 0) {
        int sent = send(client, data, (int)len, 0);
        if (sent <= 0) return;
        data += sent;
        len -= (size_t)sent;
    }
}

static void send_response(socket_t client, const char *status, const char *type, const char *body)
{
    char header[512];
    size_t len = strlen(body);
    snprintf(header, sizeof(header),
             "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\n"
             "Cache-Control: no-store\r\nConnection: close\r\n\r\n",
             status, type, len);
    send_all(client, header, strlen(header));
    send_all(client, body, len);
}

static void send_file(socket_t client, const char *url_path)
{
    char path[256];
    if (strcmp(url_path, "/") == 0) {
        snprintf(path, sizeof(path), "public/index.html");
    } else if (strstr(url_path, "..") == NULL) {
        snprintf(path, sizeof(path), "public%s", url_path);
    } else {
        send_response(client, "400 Bad Request", "text/plain", "Bad path");
        return;
    }

    FILE *fp = fopen(path, "rb");
    if (!fp) {
        send_response(client, "404 Not Found", "text/plain", "Not found");
        return;
    }
    fseek(fp, 0, SEEK_END);
    long size = ftell(fp);
    fseek(fp, 0, SEEK_SET);
    if (size < 0) {
        fclose(fp);
        send_response(client, "500 Internal Server Error", "text/plain", "File error");
        return;
    }
    char *body = (char *)malloc((size_t)size + 1u);
    if (!body) {
        fclose(fp);
        send_response(client, "500 Internal Server Error", "text/plain", "Out of memory");
        return;
    }
    size_t read_bytes = fread(body, 1, (size_t)size, fp);
    body[read_bytes < (size_t)size ? read_bytes : (size_t)size] = '\0';
    fclose(fp);
    send_response(client, "200 OK", content_type_for(path), body);
    free(body);
}

static int compare_talkers(const void *a, const void *b)
{
    const talker_snapshot_t *ta = (const talker_snapshot_t *)a;
    const talker_snapshot_t *tb = (const talker_snapshot_t *)b;
    uint64_t ca = ta->count;
    uint64_t cb = tb->count;
    return (cb > ca) - (cb < ca);
}

static void send_stats(socket_t client)
{
    static uint64_t last_time_us = 0;
    static uint64_t last_processed = 0;

    uint64_t current_time = now_us();
    uint64_t processed = atomic_load(&g_stats.processed);
    uint64_t throughput = 0;
    if (last_time_us != 0 && current_time > last_time_us) {
        throughput = ((processed - last_processed) * 1000000ull) / (current_time - last_time_us);
    }
    last_time_us = current_time;
    last_processed = processed;

    uint64_t samples = atomic_load(&g_stats.latency_samples);
    uint64_t avg_latency = samples ? atomic_load(&g_stats.latency_total_us) / samples : 0;
    uint64_t tcp = atomic_load(&g_stats.tcp);
    uint64_t udp = atomic_load(&g_stats.udp);
    uint64_t icmp = atomic_load(&g_stats.icmp);
    uint64_t other = atomic_load(&g_stats.other);
    uint64_t seq_latency = atomic_load(&g_stats.sequential_latency_us);
    uint64_t par_latency = atomic_load(&g_stats.parallel_latency_us);
    double speedup = par_latency ? ((double)seq_latency / (double)par_latency) : 0.0;

    talker_snapshot_t copy[MAX_TALKERS];
    for (size_t i = 0; i < MAX_TALKERS; ++i) {
        copy[i].ip = (uint32_t)atomic_load(&g_stats.talkers[i].ip);
        copy[i].count = atomic_load(&g_stats.talkers[i].count);
    }
    qsort(copy, MAX_TALKERS, sizeof(copy[0]), compare_talkers);

    char body[4096];
    size_t used = 0;
    used += (size_t)snprintf(body + used, sizeof(body) - used,
        "{\"mode\":\"%s\",\"generated\":%" PRIu64 ",\"processed\":%" PRIu64
        ",\"processedPackets\":%" PRIu64 ",\"throughput\":%" PRIu64 ",\"throughputRate\":%" PRIu64
        ",\"drops\":%" PRIu64 ",\"packetDrops\":%" PRIu64
        ",\"speedup\":%.2f,\"simulationSpeedup\":%.2f"
        ",\"latencyUs\":%" PRIu64 ",\"sequentialLatencyUs\":%" PRIu64
        ",\"parallelLatencyUs\":%" PRIu64 ",\"protocols\":{\"tcp\":%" PRIu64
        ",\"udp\":%" PRIu64 ",\"icmp\":%" PRIu64 ",\"other\":%" PRIu64 "},\"talkers\":[",
        atomic_load(&g_mode) == MODE_PARALLEL ? "parallel" : "sequential",
        atomic_load(&g_stats.generated), processed, processed, throughput, throughput,
        atomic_load(&g_stats.dropped), atomic_load(&g_stats.dropped), speedup, speedup,
        avg_latency, seq_latency, par_latency, tcp, udp, icmp, other);

    int emitted = 0;
    for (size_t i = 0; i < MAX_TALKERS && emitted < 5; ++i) {
        uint64_t count = copy[i].count;
        uint32_t ip_value = copy[i].ip;
        if (ip_value == 0 || count == 0) continue;
        char ip[32];
        ip_to_string(ip_value, ip, sizeof(ip));
        used += (size_t)snprintf(body + used, sizeof(body) - used,
                                 "%s{\"ip\":\"%s\",\"count\":%" PRIu64 "}",
                                 emitted ? "," : "", ip, count);
        emitted++;
    }

    snprintf(body + used, sizeof(body) - used, "]}");
    send_response(client, "200 OK", "application/json; charset=utf-8", body);
}

static void handle_client(socket_t client)
{
    char request[2048];
    int received = recv(client, request, sizeof(request) - 1, 0);
    if (received <= 0) return;
    request[received] = '\0';

    char method[8] = {0};
    char path[256] = {0};
    sscanf(request, "%7s %255s", method, path);

    if (strcmp(method, "POST") == 0) {
        if (strncmp(path, "/api/log", 8) == 0) {
            char *body = strstr(request, "\r\n\r\n");
            if (body) {
                body += 4;
            } else {
                body = "";
            }

            const char *file_path = NULL;
            if (strcmp(path, "/api/log/json") == 0) {
                file_path = "results/raw_output/ui_output.json";
            } else {
                file_path = "results/raw_output/ui_output.log";
            }

#ifdef _WIN32
            _mkdir("results");
            _mkdir("results/raw_output");
#else
            mkdir("results", 0777);
            mkdir("results/raw_output", 0777);
#endif

            FILE *f = fopen(file_path, "ab");
            if (f) {
                fprintf(f, "%s\n", body);
                fclose(f);
                send_response(client, "200 OK", "text/plain", "Logged successfully");
            } else {
                send_response(client, "500 Internal Server Error", "text/plain", "Could not open log file");
            }
            return;
        }
        send_response(client, "404 Not Found", "text/plain", "Not found");
        return;
    }

    if (strcmp(method, "GET") != 0) {
        send_response(client, "405 Method Not Allowed", "text/plain", "GET or POST only");
        return;
    }

    if (strncmp(path, "/api/stats", 10) == 0) {
        send_stats(client);
    } else if (strncmp(path, "/api/mode", 9) == 0) {
        if (strstr(path, "sequential")) set_mode(MODE_SEQUENTIAL);
        if (strstr(path, "parallel")) set_mode(MODE_PARALLEL);
        send_stats(client);
    } else {
        char *query = strchr(path, '?');
        if (query) *query = '\0';
        send_file(client, path);
    }
}

static socket_t create_server_socket(void)
{
    socket_t server = socket(AF_INET, SOCK_STREAM, 0);
    if (server == INVALID_SOCKET) return INVALID_SOCKET;

    int yes = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(SERVER_PORT);

    if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) == SOCKET_ERROR) {
        close_socket(server);
        return INVALID_SOCKET;
    }
    if (listen(server, 16) == SOCKET_ERROR) {
        close_socket(server);
        return INVALID_SOCKET;
    }
    return server;
}

static bool start_thread(thread_t *thread, 
#ifdef _WIN32
                         unsigned (__stdcall *fn)(void *),
#else
                         void *(*fn)(void *),
#endif
                         void *arg)
{
#ifdef _WIN32
    uintptr_t h = _beginthreadex(NULL, 0, fn, arg, 0, NULL);
    *thread = (HANDLE)h;
    return h != 0;
#else
    return pthread_create(thread, NULL, fn, arg) == 0;
#endif
}

int main(void)
{
#ifdef _WIN32
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed\n");
        return 1;
    }
#endif

    ring_init(&g_ring);
    thread_t producer;
    thread_t workers[WORKER_COUNT];
    start_thread(&producer, producer_thread, NULL);
    for (int i = 0; i < WORKER_COUNT; ++i) {
        start_thread(&workers[i], worker_thread, NULL);
    }

    socket_t server = create_server_socket();
    if (server == INVALID_SOCKET) {
        fprintf(stderr, "Could not start server on port %d\n", SERVER_PORT);
        return 1;
    }

    printf("NetScale is running at http://localhost:%d\n", SERVER_PORT);
    printf("Press Ctrl+C to stop.\n");

    while (atomic_load(&g_running)) {
        struct sockaddr_in client_addr;
#ifdef _WIN32
        int len = sizeof(client_addr);
#else
        socklen_t len = sizeof(client_addr);
#endif
        socket_t client = accept(server, (struct sockaddr *)&client_addr, &len);
        if (client == INVALID_SOCKET) continue;
        handle_client(client);
        close_socket(client);
    }

    close_socket(server);
#ifdef _WIN32
    WSACleanup();
#endif
    return 0;
}
