FROM python:3.12.4-bookworm AS build
LABEL org.opencontainers.image.source https://github.com/ozfortress/drawbridge

ARG GIT_COMMIT
# Some deploy platforms (e.g. Coolify) pass the commit under this name instead
ARG SOURCE_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN apt update && apt install -y socat libmariadb-dev libmariadb-dev-compat gcc
WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Extract commit hash from .git files directly (avoids git command issues), then
# save its author, date and message for the startup message if git can read it.
# Without .git_commit_info, app.py looks the commit up on the GitHub API instead.
RUN set -ex; \
    commit=""; \
    if [ -n "$GIT_COMMIT" ]; then \
        commit="$GIT_COMMIT"; \
    elif [ -n "$SOURCE_COMMIT" ]; then \
        commit="$SOURCE_COMMIT"; \
    elif [ -f .git/HEAD ]; then \
        head_ref=$(cat .git/HEAD); \
        case "$head_ref" in \
            ref:*) ref=$(echo "$head_ref" | cut -d' ' -f2); \
                   if [ -f ".git/$ref" ]; then \
                       commit=$(cat ".git/$ref"); \
                   elif [ -f .git/packed-refs ]; then \
                       commit=$(awk -v r="$ref" '$2 == r {print $1}' .git/packed-refs); \
                   fi;; \
            *)     commit="$head_ref";; \
        esac; \
    fi; \
    echo "$commit" > .git_commit; \
    echo "commit: ${commit:-unknown}"; \
    if [ -n "$commit" ] && git -c safe.directory='*' log -1 --format='%an <%ae>%n%ad%n%B' "$commit" > .git_commit_info 2>/dev/null; then \
        cat .git_commit_info; \
    else \
        rm -f .git_commit_info; \
    fi
EXPOSE 8080

# Health check using the Python script
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python healthcheck.py || exit 1

CMD [ "python", "./app.py" ]
