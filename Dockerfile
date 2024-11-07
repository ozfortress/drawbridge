FROM python:3.12.4-bookworm AS build

WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN git config --global --add safe.directory /usr/src/app
COPY . .

CMD [ "python", "./app.py" ]

HEALTHCHECK --interval=15s --timeout=10s --start-period=10s --retries=3 \
    CMD (echo "ping" | socat - UNIX-CONNECT:/tmp/drawbridge.sock) | grep -q "OK" || exit 1
