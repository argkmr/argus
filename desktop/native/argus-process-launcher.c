/* OS-only primitive for Java's owned processes. No network, storage or application logic. */
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fputs("An executable is required\n", stderr);
        return 64;
    }
    /* The PID returned to Java becomes a private session and process-group ID.
       Children stay addressable even if their immediate parent exits. */
    if (setsid() == -1) {
        perror("Could not isolate the owned process");
        return 71;
    }
    execvp(argv[1], &argv[1]);
    int exec_error = errno;
    perror("Could not launch the owned executable");
    return exec_error == ENOENT ? 127 : 126;
}
