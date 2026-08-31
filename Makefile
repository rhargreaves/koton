dev:
	npx wrangler dev
.PHONY: dev

deploy:
	npx wrangler deploy
.PHONY: deploy

typecheck:
	npx tsc --noEmit
.PHONY: typecheck

build:
	npx wrangler deploy --dry-run
.PHONY: build

lint:
	python3 -m py_compile client/push-gua.py
.PHONY: lint

check: typecheck build lint
.PHONY: check
