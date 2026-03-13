#!/bin/bash
# bootstrap.sh — sets up the open-agent project directory and optionally starts Claude Code.
# Run from wherever you want the project to live (e.g., ~/src/open-agent).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Setting up open-agent project..."
echo "SCRIPT_DIR: $SCRIPT_DIR"

# Copy project files (skip this script and PROMPT.md)
# for f in agent.ts install.sh README.md; do
#     if [[ -f "$SCRIPT_DIR/$f" ]]; then
#         cp "$SCRIPT_DIR/$f" .
#         echo "  copied $f"
#     fi
# done

for d in remote config; do
    if [[ -d "$SCRIPT_DIR/$d" ]]; then
        cp -r "$SCRIPT_DIR/$d" .
        echo "  copied $d/"
    fi
done

chmod +x install.sh remote/ropen 2>/dev/null || true

# Copy rproj for reference
if [[ -f "$HOME/bin/rproj" ]]; then
    mkdir -p ref
    cp "$HOME/bin/rproj" ref/rproj
    echo "  copied ~/bin/rproj to ref/ for reference"
else
    echo "  note: ~/bin/rproj not found — copy it to ref/rproj manually if needed"
fi

# Initialize git
if [[ ! -d .git ]]; then
    git init
    cat > .gitignore << 'EOF'
node_modules/
.DS_Store
*.log
EOF
    git add -A
    git commit -m "Initial open-agent scaffolding from chat session"
    echo "  initialized git repo"
fi

echo ""
echo "Project ready. To start Claude Code:"
echo ""
echo "  claude"
echo ""
echo "Then paste or reference the prompt from:"
echo "  $SCRIPT_DIR/PROMPT.md"
echo ""
echo "Or start directly with:"
echo '  claude "$(cat '"$SCRIPT_DIR/PROMPT.md"')"'
