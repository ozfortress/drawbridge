# Drawbridge

Drawbridge is a Python bot designed to assist ozfortress tournament admins with the operation of active cups and seasonal tournaments. It is compatible with any Citadel-powered league.

It's features include

- Automated creation of Division categories and roles
- Automated creation of Team channels and roles
- Automated creation of Match channels
- Assisted Demochecking (in which logs are checked to identify a player who played)
- Logging of all match communications
- A launchpad to find your way around

Still to come

- Automated team captain assignment
    - Blocked by Citadel API not including captain information
- Automatic Database configuration
    - TODO
- Web Interface for fetching logs, configuring embeds, etc

## Getting Started

This application is powered by Python 3.12.3. All dependencies are pinned in requirements.txt. To get started, install Python 3.12.3 and run the following commands:

Linux:
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Windows:
```cmd
python3.12.3 -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

The application is configured using environment variables. Create a .env file in the root directory of the project by copying the .env.example file and filling in the required values.

Note: The database is not auto-configured. You will have to apply the template database.

To run the application, after activating the venv as seen above, execute the following command:

```bash
python app.py
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines on contributing to this project.

## License

This project's licensing is still being determined. See [LICENSE.md](LICENSE.md) for more information.
