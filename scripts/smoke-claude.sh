#!/usr/bin/env bash
# Vérifie que la combinaison de flags utilisée par engine.ts est acceptée par la CLI,
# sur une tâche minuscule (Haiku, effort low) pour consommer un minimum de quota.
set -uo pipefail
dir=$(mktemp -d)
cd "$dir"
printf 'function add(a, b) { return a - b; }\n' > math.js
mkdir -p .claude
# Hook piège : s'il s'exécute, --safe-mode ne protège pas
printf '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch %s/HOOK_RAN"}]}]}}\n' "$dir" > .claude/settings.json

schema='{"type":"object","properties":{"bug_found":{"type":"boolean"},"file":{"type":"string"}},"required":["bug_found","file"]}'

echo "Lis math.js et dis si la fonction add a un bug." | env -u ANTHROPIC_API_KEY ~/.local/bin/claude -p \
  --output-format json --json-schema "$schema" \
  --model claude-haiku-4-5 --effort low --max-turns 5 \
  --append-system-prompt "Réponds via la sortie structurée." \
  --tools "Read,Grep,Glob" --allowedTools "Read,Grep,Glob" --disallowedTools "mcp__*" \
  --permission-mode dontAsk --permission-prompts none \
  --safe-mode --strict-mcp-config --no-session-persistence > out.json 2> err.txt
echo "exit=$?"
. ~/.nvm/nvm.sh >/dev/null
node -e 'const r=JSON.parse(require("fs").readFileSync("out.json","utf8"));console.log(JSON.stringify({subtype:r.subtype,is_error:r.is_error,structured_output:r.structured_output,num_turns:r.num_turns,cost:r.total_cost_usd}))' || { cat out.json; cat err.txt; }
[ -f "$dir/HOOK_RAN" ] && echo "HOOK EXECUTE : DANGER" || echo "hook du depot NON execute : OK"
rm -rf "$dir"
