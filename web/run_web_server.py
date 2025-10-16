#!/usr/bin/env python3
"""
Standalone web server runner
Use this to run just the web server without the Discord bot
"""

import sys
import os
from pathlib import Path

# Add parent directory to path for module imports
parent_dir = Path(__file__).parent.parent
sys.path.insert(0, str(parent_dir))

if __name__ == '__main__':
    from simple_web_server import app
    
    host = os.getenv('WEB_HOST', '127.0.0.1')
    port = int(os.getenv('WEB_PORT', 8080))
    
    print(f"🌐 Starting web server on {host}:{port}")
    print("📝 Web interface for viewing match & team communications")
    
    app.run(host=host, port=port, debug=False)