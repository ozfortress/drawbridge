FROM python:3.12.4-bookworm AS build
LABEL org.opencontainers.image.source https://github.com/ozfortress/drawbridge

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT}

RUN apt update && apt install -y socat
WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Write commit info for runtime (git may not be available at runtime)
RUN git rev-parse HEAD > .git_commit 2>/dev/null || echo ${GIT_COMMIT:-unknown} > .git_commit
RUN git log -1 --format='%an' > .git_commit_author 2>/dev/null || echo "unknown" > .git_commit_author
RUN git log -1 --format='%s' > .git_commit_msg 2>/dev/null || echo "" > .git_commit_msg
EXPOSE 8080

# Health check using the Python script
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python healthcheck.py || exit 1

CMD [ "python", "./app.py" ]
