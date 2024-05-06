# Drawbridge

Drawbridge aims to be a modular Discord Bot designed to interface with the Citadel esports framework in order to provide a streamlined match organizing and captaincy experience.

The goal of this project is to enable end users to register within a discord server to receive roles and alerts for upcoming matches, as well as to provide a platform for league admins to manage captains and matches.

At this early stage, the application is still in development and does not function. The following features are planned for the initial release:

- [ ] Account linking between Discord and Steam (for the purposes of identifying a user on Citadel)
- [ ] Administration Panel for importing matches from Citadel
- [ ] Pick/Ban management for captains
- [ ] User/Role management
- [ ] Match Comms management (including archival and retrieval)

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

To run the application, after activating the venv as seen above, execute the following command:

```bash
python app.py
```

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for guidelines on contributing to this project.

## License

This project's licensing is still being determined. See [LICENSE.md](LICENSE.md) for more information.
