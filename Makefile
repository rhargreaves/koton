dev:
	npx wrangler dev
.PHONY: dev

deploy:
	npx wrangler deploy
.PHONY: deploy

typecheck:
	npx tsc --noEmit
.PHONY: typecheck

test:
	npm test
.PHONY: test

build:
	npx wrangler deploy --dry-run
.PHONY: build

lint:
	python3 -m py_compile client/push-gua.py
.PHONY: lint

check: typecheck test build lint
.PHONY: check
