# WebXTL

**Web-Based Shelxl Viewer and Editor**

WebXTL is a modern web application designed for viewing and editing crystallographic files (SHELX format). It provides a seamless interface for visualizing molecular structures in 3D while editing the corresponding `.res` or `.ins` files.

## Features

-   **Dual-Pane Interface**: Split view with a syntax-highlighted Shelx text editor (Ace Editor) and a high-performance 3D molecular viewer (Three.js).
-   **Live Updates**: Changes in the editor are reflected in the 3D view (re-render on demand).
-   **SHELX Support**: Specialized syntax highlighting and command autocompletion for SHELX keywords (`AFIX`, `PART`, `HFIX`, etc.).
-   **Advanced Atom Sorting**: Smart sorting of atoms that keeps riding atoms (Hydrogens, Q-peaks, AFIX groups) attached to their parents.
-   **Toolbar Tools**:
    -   **Kill Q/H**: Quickly remove Q-peaks or Hydrogen atoms.
    -   **Relabel Atoms**: Renumber/rename atoms automatically.
    -   **Sort Atoms**: Reorder atoms alphabetically.
    -   **Search**: Find and replace text.
-   **Project Management**: Server-side project loading and saving.
-   **Development Workflow**: Built with Vite for fast HMR and optimized production builds.

## Installation

1.  Clone the repository:
    ```bash
    git clone https://github.com/dspasyuk/WebXTL.git
    cd WebXTL
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Start the development server:
    ```bash
    npm run dev
    ```

4.  Build for production:
    ```bash
    npm run build
    ```

5.  Run the server (production mode):
    ```bash
    node server.js
    ```

## Technolgies

-   **Frontend**: HTML5, CSS3, JavaScript (ES6+), Bootstrap 5
-   **Build Tool**: Vite
-   **3D Graphics**: Three.js
-   **Text Editor**: Ace Editor
-   **Layout**: Split-Grid
-   **Backend**: Node.js / Express (for serving and project management)

## License

MIT License. See `package.json` for details.
