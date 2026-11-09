#!/usr/bin/env bash
# Astro's dev toolbar covers the page bottom in screenshots and adds a second `button "Menu"`.
# It mounts a moment after load, so this waits for it.
set -euo pipefail

agent-browser eval --stdin <<'EOF'
new Promise((resolve) => {
	const started = Date.now();
	const timer = setInterval(() => {
		const toolbar = document.querySelector('astro-dev-toolbar');
		if (toolbar || Date.now() - started > 5000) {
			clearInterval(timer);
			toolbar?.remove();
			resolve(toolbar ? 'dev toolbar removed' : 'no dev toolbar');
		}
	}, 100);
});
EOF
