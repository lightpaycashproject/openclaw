#!/bin/bash
set -e

# Ensure we are in the repo root
cd "$(dirname "$0")/.."
REPO_ROOT=$(pwd)

echo "🦞 Force Upgrading OpenClaw Source..."

# 1. Update Code
echo "1. Pulling latest changes..."
git pull

# 2. Build
echo "2. Installing dependencies and building..."
pnpm install
pnpm build

# 3. Force Service Reinstall
# The --force flag is now reliably handled by our CLI fixes
echo "3. Reinstalling Gateway Service..."
node openclaw.mjs gateway install --force

# 4. Restart Service
echo "4. Restarting Gateway..."
node openclaw.mjs gateway restart

# 5. Override Binary
echo "5. Overriding 'openclaw' binary to point to source..."

create_wrapper() {
  local target="$1"
  echo "Generating source wrapper at $target..."
  cat <<EOF > "$target"
#!/bin/bash
# OpenClaw Source Wrapper (Aliased to pnpm openclaw)
# Repo: $REPO_ROOT
pnpm --dir "$REPO_ROOT" openclaw "\$@"
EOF
  chmod +x "$target"
}

is_source_file() {
  local target="$1"
  local abs_target
  abs_target=$(realpath -m "$target" 2>/dev/null || echo "$target")
  local abs_repo
  abs_repo=$(realpath -m "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")
  local filename
  filename=$(basename "$target")

  # CRITICAL SAFETY: Never touch openclaw.mjs or anything inside the repo.
  if [[ "$abs_target" == "$abs_repo"* ]]; then return 0; fi
  if [[ "$filename" == "openclaw.mjs" ]]; then return 0; fi
  if [[ "$target" == *".mjs" ]]; then return 0; fi
  if [[ "$target" == *".js" ]]; then return 0; fi
  
  return 1
}

override_binary() {
  local target="$1"
  if [ -z "$target" ]; then return 1; fi
  
  if is_source_file "$target"; then
    echo "Skipping override: target is identified as a source file ($target)"
    return 1
  fi

  if [ -f "$target" ] || [ -L "$target" ]; then
    echo "Found binary at $target"
    if [ -L "$target" ]; then
       echo "It is a symlink. Removing..."
       rm "$target"
    else
       echo "Backing up original to ${target}.bak"
       mv "$target" "${target}.bak"
    fi
    create_wrapper "$target"
    echo "✓ Created wrapper at $target -> pnpm --dir $REPO_ROOT openclaw"
    return 0
  fi
  return 1
}

# 1. Attempt to replace existing known openclaw locations
OVERRIDDEN=false
for loc in "/home/linuxbrew/.linuxbrew/bin/openclaw" "/usr/local/bin/openclaw" "$(which openclaw 2>/dev/null)"; do
  if [ -n "$loc" ] && override_binary "$loc"; then
    OVERRIDDEN=true
  fi
done

# 2. Fallback: Create in ~/.local/bin if nothing was overridden
if [ "$OVERRIDDEN" = false ]; then
  LOCAL_BIN="$HOME/.local/bin/openclaw"
  if ! is_source_file "$LOCAL_BIN"; then
    echo "Creating new wrapper in ~/.local/bin..."
    mkdir -p "$(dirname "$LOCAL_BIN")"
    create_wrapper "$LOCAL_BIN"
    echo "✓ Created wrapper in $LOCAL_BIN"
  else
    echo "Warning: skipped ~/.local/bin/openclaw as it overlaps with source."
  fi
fi

# Ensure source remains executable
chmod +x "$REPO_ROOT/openclaw.mjs"

echo ""
echo "✅ Force upgrade complete!"
echo "Version check:"
"$REPO_ROOT/openclaw.mjs" --version
