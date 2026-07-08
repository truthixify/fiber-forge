.PHONY: setup build test lint fmt fmt-check ci clean

setup:
	npm ci

build:
	npm run build

test:
	npm test

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

ci: fmt-check lint test build

clean:
	rm -rf dist node_modules
