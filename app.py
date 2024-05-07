if __name__ != '__main__':
    raise ImportError('This is not a module. Please run app.py instead.')

import logging
import os
from dotenv import load_dotenv
import subprocess


load_dotenv()

if not os.path.exists('logs'):
    os.makedirs('logs')
logger = logging.getLogger(__name__)
VERSION = '0.0.1'

class Drawbridge: pass

def main():
    logging.basicConfig(filename='logs/drawbridge.log', level=logging._nameToLevel[os.getenv('LOG_LEVEL', 'INFO')], format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    logger.info(f'Starting OZF Drawbridge v{VERSION}...')
    checkPackages()
    loaded = loadModule('citadel')
    if not loaded:
        logger.error('Could not load required modules. Exiting...')
        return
    logger.info('OZF Drawbridge has started.')



def checkPackages():
    with open('requirements.txt', 'r') as file:
        requiredPackages = file.read().splitlines()
    installedPackages = subprocess.check_output(['pip', 'freeze']).decode('utf-8').splitlines()
    missingPackages = [package for package in requiredPackages if package not in installedPackages]
    if missingPackages:
        logger.warning(f'The following packages are missing: {missingPackages}')
        logger.warning('Installing missing packages...')
        subprocess.check_call(['pip', 'install', *missingPackages])
        logger.info('All missing packages have been installed.')
    else:
        logger.info('All packages are already installed.')

def loadModule(module):
    try:
        __import__(f'modules.{module}', globals(), locals(), ['*'])
    except ImportError:
        logger.error(f'Could not load module {module}.')
        return False
    return True

if __name__ == '__main__':
    main()

# Path: app.py
