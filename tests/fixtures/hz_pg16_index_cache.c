/* Only the source segments of a dedicated, disposable tablespace are accepted.
 * O_RDONLY + POSIX_FADV_DONTNEED targets these files; no system cache control. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static uint64_t resident(int fd, size_t bytes, long page) {
    if (!bytes) return 0;
    size_t pages = (bytes + (size_t)page - 1)/(size_t)page;
    void *mapping = mmap(NULL, bytes, PROT_NONE, MAP_SHARED, fd, 0);
    if (mapping == MAP_FAILED) { perror("mmap"); exit(1); }
    unsigned char *vec = calloc(pages, 1);
    if (!vec || mincore(mapping,bytes,vec)) { perror("mincore"); exit(1); }
    uint64_t n = 0;
    for (size_t i=0; i<pages; i++) if (vec[i]&1) n++;
    free(vec); munmap(mapping,bytes);
    return n;
}
int main(int argc,char **argv) {
    if (argc<3 || strcmp(argv[1],"evict-fixture-sources") || geteuid()==0) return 2;
    long page=sysconf(_SC_PAGESIZE);
    uint64_t size=0,before=0,after=0,segments=0;
    for (int i=2;i<argc;i++) {
        if (strncmp(argv[i],"/tmp/hz-pg16-index-",19) || strstr(argv[i],"..")) return 2;
        for (int s=0;;s++) {
            char path[4096];
            int len = s ? snprintf(path,sizeof(path),"%s.%d",argv[i],s) : snprintf(path,sizeof(path),"%s",argv[i]);
            if (len<0 || (size_t)len>=sizeof(path)) return 2;
            int fd=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
            if (fd<0 && s && errno==ENOENT) break;
            if (fd<0) { perror("fixture source open");return 1; }
            struct stat st;
            if (fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || st.st_size<0) return 2;
            uint64_t r=resident(fd,(size_t)st.st_size,page);
            int err=posix_fadvise(fd,0,0,POSIX_FADV_DONTNEED);
            if(err){fprintf(stderr,"posix_fadvise: %s\n",strerror(err));return 1;}
            before+=r;after+=resident(fd,(size_t)st.st_size,page);
            size+=(uint64_t)st.st_size;segments++;close(fd);
        }
    }
    printf("{\"sourceBytes\":%"PRIu64",\"segments\":%"PRIu64",\"residentBeforeBytes\":%"PRIu64",\"residentAfterBytes\":%"PRIu64"}\n",size,segments,before*page,after*page);
    return 0;
}
