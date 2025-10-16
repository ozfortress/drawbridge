#!/usr/bin/env python3
"""
Docker health check script for Drawbridge bot.
Checks both the bot health API and the Unix socket health check.
"""

import sys
import socket
import urllib.request
import urllib.error
import json
import os


def check_unix_socket():
    """Check the Unix socket health endpoint."""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect('/tmp/drawbridge.sock')
        sock.send(b'ping')
        response = sock.recv(1024)
        sock.close()
        return response == b'OK'
    except Exception:
        return False


def check_web_api():
    """Check the web API health endpoint."""
    try:
        port = os.getenv('WEB_PORT', '8080')
        url = f'http://localhost:{port}/api/health'
        
        req = urllib.request.Request(url, headers={'User-Agent': 'HealthCheck/1.0'})
        response = urllib.request.urlopen(req, timeout=5)
        
        if response.status == 200:
            data = json.loads(response.read().decode())
            return data.get('status') == 'healthy'
        else:
            return False
    except Exception:
        return False


def main():
    """Main health check function."""
    socket_ok = check_unix_socket()
    web_ok = check_web_api()
    
    if socket_ok and web_ok:
        print("Health check passed: Both socket and web API are healthy")
        sys.exit(0)
    elif socket_ok:
        print("Health check warning: Socket OK but web API failed")
        sys.exit(0)  # Still consider healthy if main bot is running
    elif web_ok:
        print("Health check warning: Web API OK but socket failed")
        sys.exit(0)  # Still consider healthy if web server is running
    else:
        print("Health check failed: Both socket and web API are unhealthy")
        sys.exit(1)


if __name__ == '__main__':
    main()