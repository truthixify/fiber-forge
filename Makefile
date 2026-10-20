.PHONY: setup build test e2e sdk-test package-test lint fmt fmt-check ci clean

setup:
	npm ci

build:
	npm run build

test:
	npm test

e2e:
	npm run test:e2e

sdk-test: build
	npm run test:sdk

package-test: build
	npm run test:package

lint:
	npm run lint

fmt:
	npm run fmt

fmt-check:
	npm run fmt:check

ci: fmt-check lint test sdk-test package-test

clean:
	rm -rf dist node_modules
