FROM python:3.12.4-bookworm AS build
LABEL org.opencontainers.image.source https://github.com/ozfortress/drawbridge

RUN apt update && apt install -y socat
WORKDIR /usr/src/app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN git config --global --add safe.directory /usr/src/app
COPY . .
EXPOSE 8080

# Health check using the Python script
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python healthcheck.py || exit 1

CMD [ "python", "./app.py" ]
