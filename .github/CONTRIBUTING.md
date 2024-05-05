# Contributing Guidelines

Thank you for considering contributing to this project! We appreciate your time and effort. To ensure a smooth collaboration, please follow these guidelines when making contributions.

## Table of Contents
- [Conventional Commits](#conventional-commits)
- [Pull Requests](#pull-requests)
- [Code Style](#code-style)
- [Naming Convention](#naming-convention)
- [Documentation](#documentation)
- [Issue Reporting](#issue-reporting)
- [License](#license)

## Conventional Commits

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification for our commit messages. This helps us maintain a clear and consistent commit history. Please make sure your commit messages adhere to this format.

## Pull Requests

1. Fork the repository and create a new branch from `main`.
2. Make your changes, ensuring that your code follows our code style guidelines.
3. Write tests to cover your changes, if applicable.
    * This is optional at this early stage of development.
4. Commit your changes using the conventional commit format.
5. Push your branch to your forked repository.
6. Open a pull request against the `main` branch of this repository.
7. Provide a clear and descriptive title for your pull request.
8. Include a detailed description of the changes you made and why they are necessary.
9. Assign relevant reviewers to your pull request.
10. Address any feedback or comments from the reviewers.

## Code Style

We follow a consistent code style throughout the project. Please ensure that your code adheres to the existing style. Some key points to keep in mind:

- Use meaningful variable and function names.
- Write clear and concise comments to explain complex logic.
- Follow the established indentation and formatting conventions.

## Naming Convention

Within this project we use a naming convention for all aspects of code. Here's a rundown of what that convention is.

- **Variables and Functions**: `camelCase` - Please use one or two words for variable names where possible.
- **Classes**: `PascalCase` - Inherited classes should be named with the parent class name, for example: `class HittableBox extends Box`
- **Constants**: `UPPER_CASE` - Minimize the use of constants where possible.
- **Files and Directories**: `kebab-case` - Please use single word names for directories where possible.
- **Branches**: `type/kebab-case` - Please name your branches so we can identify what the branch is for. For example: `feature/add-documentation`
- **Commits**: `Conventional Commits` - Please use the [Conventional Commits](https://www.conventionalcommits.org/) specification for our commit messages.

This all may seem overkill, but it's important to keep the codebase clean and consistent for future maintainers.


## Documentation

Good documentation is essential for maintaining and understanding the project. If you make changes that require updating the documentation, please do so in a separate commit.

## Issue Reporting

If you encounter any issues or have suggestions for improvements, please open an issue in the issue tracker. Provide a clear and detailed description of the problem or suggestion, along with any relevant information or steps to reproduce the issue.

## License

By contributing to this project, you agree that your contributions will be licensed under the [LICENSE](/LICENSE) file of this repository.

---

These guidelines are meant to ensure a collaborative and productive environment for everyone involved. Thank you for your contributions!
