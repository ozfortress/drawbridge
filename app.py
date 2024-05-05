if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv

load_dotenv()

if not os.path.exists('logs'):
    os.makedirs('logs')
logger = logging.getLogger(__name__)
_version = '0.0.1'

def main():
    logging.basicConfig(filename='logs/drawbridge.log', level=logging._nameToLevel[os.getenv('LOG_LEVEL', 'INFO')], format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    logger.info(f'Starting OZF Drawbridge v{_version}...')

if __name__ == '__main__':
    main()

# Path: app.py
