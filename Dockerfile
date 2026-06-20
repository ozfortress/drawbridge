FROM python:3.12.4-bookworm AS build
LABEL org.opencontainers.image.source https://github.com/ozfortress/drawbridge

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN apt update && apt install -y socat
WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Extract commit hash from .git files directly (avoids git command issues)
RUN set -ex; \
    commit=""; \
    if [ -n "$GIT_COMMIT" ]; then \
        commit="$GIT_COMMIT"; \
    elif [ -f .git/HEAD ]; then \
        head_ref=$(cat .git/HEAD); \
        case "$head_ref" in \
            ref:*) ref_path=".git/$(echo "$head_ref" | cut -d' ' -f2)"; \
                   [ -f "$ref_path" ] && commit=$(cat "$ref_path");; \
            *)     commit="$head_ref";; \
        esac; \
    fi; \
    echo "${commit:-unknown}" > .git_commit; \
    echo "commit: $(cat .git_commit)"
EXPOSE 8080

# Health check using the Python script
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python healthcheck.py || exit 1

CMD [ "python", "./app.py" ]
