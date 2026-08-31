dev:
	npx wrangler dev
.PHONY: dev

deploy:
	npx wrangler deploy
.PHONY: deploy

typecheck:
	npx tsc --noEmit
.PHONY: typecheck
