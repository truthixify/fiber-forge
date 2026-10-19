.PHONY: setup build test sdk-test lint fmt fmt-check ci clean

setup:
	npm ci

build:
	npm run build

test:
	npm test

sdk-test: build
	npm run test:sdk

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

ci: fmt-check lint test sdk-test

clean:
	rm -rf dist node_modules
