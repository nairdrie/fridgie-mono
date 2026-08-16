# Fridgie monorepo — local development.
#
#   make            list targets
#   make setup      install everything
#   make dev        run API + Metro together (the usual one)
#   make ios        build & launch the iOS dev client (needs Xcode)
#
# Deliberately plain make: this repo is not a package-manager workspace, so
# Turborepo/Nx have nothing to hook into, and make is already on every Mac.

SHELL := /bin/bash
.DEFAULT_GOAL := help

API_DIR    := apps/api
MOBILE_DIR := apps/mobile
SHARED_DIR := packages/shared

API_PORT ?= 3000

# The phone and the simulator both need a routable address, not localhost.
LAN_IP := $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
API_URL ?= http://$(LAN_IP):$(API_PORT)/api

BUN := $(shell command -v bun 2>/dev/null || echo /opt/homebrew/bin/bun)

# `xcode-select` commonly points at the Command Line Tools even when Xcode is
# installed, which makes xcodebuild refuse to run. Repointing it needs sudo, so
# rather than demand that, just aim DEVELOPER_DIR at Xcode ourselves when we can
# see it. Set DEVELOPER_DIR yourself to override.
# CocoaPods aborts on a non-UTF-8 locale, which is easy to hit in a bare shell.
export LANG ?= en_US.UTF-8

XCODE_APP ?= /Applications/Xcode.app
# Captured before the export below, or it would report the value we just set.
XCODE_SELECTED := $(shell xcode-select -p 2>/dev/null)
XCODE_FALLBACK := $(shell if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$(XCODE_APP)/Contents/Developer" ]; \
	then echo "$(XCODE_APP)/Contents/Developer"; fi)
ifneq ($(XCODE_FALLBACK),)
export DEVELOPER_DIR := $(XCODE_FALLBACK)
endif

CYAN := \033[36m
DIM  := \033[2m
BOLD := \033[1m
OFF  := \033[0m

.PHONY: help
help:
	@printf "$(BOLD)Fridgie$(OFF)  api → $(CYAN)$(API_URL)$(OFF)\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-14s$(OFF) %s\n", $$1, $$2}'
	@printf "\n$(DIM)override the API host with:  make dev API_URL=http://10.0.0.5:3000/api$(OFF)\n"

# ── setup ────────────────────────────────────────────────────────────────────

.PHONY: setup
setup: check-bun ## Install dependencies for all three packages
	@printf "$(CYAN)==>$(OFF) packages/shared\n"
	@cd $(SHARED_DIR) && npm install --no-audit --no-fund
	@printf "$(CYAN)==>$(OFF) apps/api\n"
	@cd $(API_DIR) && $(BUN) install
	@printf "$(CYAN)==>$(OFF) apps/mobile\n"
	@cd $(MOBILE_DIR) && npm install --no-audit --no-fund
	@printf "\n$(BOLD)Done.$(OFF) Next: cp $(API_DIR)/.env.example $(API_DIR)/.env and fill it in, then 'make dev'.\n"

# ── running ──────────────────────────────────────────────────────────────────

.PHONY: dev
dev: check-env ## Run the API and Metro together (Ctrl-C stops both)
	@printf "$(CYAN)==>$(OFF) api on :$(API_PORT), metro in the foreground\n"
	@printf "$(DIM)    mobile will talk to $(API_URL)$(OFF)\n\n"
	@set -m; \
	( cd $(API_DIR) && $(BUN) --watch index.ts 2>&1 \
		| awk '{ printf "\033[35m[api]\033[0m %s\n", $$0; fflush() }' ) & \
	API_PGID=$$!; \
	trap 'kill -TERM -$$API_PGID 2>/dev/null; exit 0' EXIT INT TERM; \
	sleep 1; \
	cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo start --dev-client

.PHONY: api
api: check-env ## Run only the API, with live reload
	@cd $(API_DIR) && $(BUN) --watch index.ts

.PHONY: mobile
mobile: ## Run only Metro (expects the API to be running elsewhere)
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo start --dev-client

.PHONY: mobile-go
mobile-go: ## Run Metro in Expo Go mode (most native modules will NOT work)
	@printf "$(DIM)Google Sign-In and other custom native modules are unavailable in Expo Go.$(OFF)\n"
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo start

# ── ios ──────────────────────────────────────────────────────────────────────

.PHONY: ios
ios: check-xcode ## Build and launch the iOS dev client in the simulator
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:ios

.PHONY: ios-device
ios-device: check-xcode ## Build and launch on a connected iPhone
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:ios --device

.PHONY: ios-build-cloud
ios-build-cloud: ## Build a dev client via EAS (no local Xcode needed)
	@cd $(MOBILE_DIR) && npx eas-cli build --platform ios --profile development

.PHONY: android
android: ## Build and launch the Android dev client
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:android

.PHONY: prebuild
prebuild: ## Regenerate both native projects from app.json (discards local edits)
	@cd $(MOBILE_DIR) && npx expo prebuild --clean

# ── quality ──────────────────────────────────────────────────────────────────

.PHONY: check
check: typecheck test ## Typecheck both apps and run the tests

.PHONY: typecheck
typecheck: ## Typecheck both apps
	@printf "$(CYAN)==>$(OFF) api\n"
	@cd $(API_DIR) && $(BUN) x tsc --noEmit
	@printf "$(CYAN)==>$(OFF) mobile\n"
	@cd $(MOBILE_DIR) && npx tsc --noEmit
	@printf "$(BOLD)Typecheck clean.$(OFF)\n"

.PHONY: test
test: ## Run the API test suite
	@cd $(API_DIR) && $(BUN) test

.PHONY: lint
lint: ## Lint the mobile app
	@cd $(MOBILE_DIR) && npx expo lint

.PHONY: bundle-check
bundle-check: ## Verify Metro can bundle (catches shared-package resolution breaks)
	@cd $(MOBILE_DIR) && rm -rf .expo-export-check \
		&& npx expo export --platform ios --output-dir .expo-export-check \
		&& rm -rf .expo-export-check \
		&& printf "$(BOLD)Bundle OK.$(OFF)\n"

# ── docker ───────────────────────────────────────────────────────────────────

.PHONY: docker-build
docker-build: ## Build the API image (context is the repo root, by design)
	docker build -f $(API_DIR)/Dockerfile -t fridgie-api .

# ── housekeeping ─────────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Remove build output and caches (keeps node_modules)
	@rm -rf $(MOBILE_DIR)/.expo $(MOBILE_DIR)/.expo-export-check $(MOBILE_DIR)/dist
	@rm -rf $(MOBILE_DIR)/ios/build $(MOBILE_DIR)/android/build $(MOBILE_DIR)/android/app/build
	@printf "Cleaned.\n"

.PHONY: clean-all
clean-all: clean ## Also remove every node_modules and the generated ios/ project
	@rm -rf $(API_DIR)/node_modules $(MOBILE_DIR)/node_modules $(SHARED_DIR)/node_modules
	@rm -rf $(MOBILE_DIR)/ios
	@printf "Removed node_modules and ios/. Run 'make setup'.\n"

# ── guards ───────────────────────────────────────────────────────────────────

.PHONY: check-bun
check-bun:
	@command -v $(BUN) >/dev/null 2>&1 || { \
		printf "\033[31mbun not found.\033[0m  Install it:\n  brew install oven-sh/bun/bun\n"; exit 1; }

.PHONY: check-env
check-env: check-bun
	@if [ ! -f $(API_DIR)/.env ] && [ -z "$$FIREBASE_CREDENTIALS" ] \
		&& [ ! -f $(API_DIR)/utils/firebase-service-account.json ]; then \
		printf "\033[31mThe API cannot start without Firebase credentials.\033[0m\n"; \
		printf "It reads them at import time and exits immediately if they're missing.\n\n"; \
		printf "Provide either:\n"; \
		printf "  • $(API_DIR)/utils/firebase-service-account.json   (the service-account file), or\n"; \
		printf "  • FIREBASE_CREDENTIALS in $(API_DIR)/.env          (same JSON, one line)\n\n"; \
		printf "  cp $(API_DIR)/.env.example $(API_DIR)/.env\n\n"; \
		printf "$(DIM)Continuing anyway — Metro will still run, but API calls will fail.$(OFF)\n\n"; \
	fi

.PHONY: check-xcode
check-xcode:
	@if ! xcodebuild -version >/dev/null 2>&1; then \
		printf "\033[31mCannot find a usable Xcode.\033[0m\n\n"; \
		printf "xcode-select points at:  $$(xcode-select -p)\n"; \
		printf "and $(XCODE_APP) is not present either.\n\n"; \
		printf "Install Xcode from the App Store, then:\n"; \
		printf "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n"; \
		printf "  xcodebuild -runFirstLaunch\n\n"; \
		printf "Or skip local builds: $(BOLD)make ios-build-cloud$(OFF) builds a dev client with\n"; \
		printf "EAS to install on a physical iPhone, then $(BOLD)make dev$(OFF) live-reloads it.\n"; \
		exit 1; \
	fi
	@if [ -n "$(XCODE_FALLBACK)" ]; then \
		printf "$(DIM)note: xcode-select points at $(XCODE_SELECTED), so this build\n"; \
		printf "      uses DEVELOPER_DIR=$(XCODE_FALLBACK) instead.\n"; \
		printf "      To fix it permanently (needs your password):\n"; \
		printf "        sudo xcode-select -s $(XCODE_APP)/Contents/Developer$(OFF)\n\n"; \
	fi
	@command -v pod >/dev/null 2>&1 || { \
		printf "\033[31mCocoaPods is required to build for iOS.\033[0m\n\n"; \
		printf "  brew install cocoapods\n\n"; \
		exit 1; }

.PHONY: doctor
doctor: ## Report on the local toolchain
	@printf "$(BOLD)toolchain$(OFF)\n"
	@printf "  bun        %s\n" "$$($(BUN) --version 2>/dev/null || echo 'MISSING — brew install oven-sh/bun/bun')"
	@printf "  node       %s\n" "$$(node --version 2>/dev/null || echo MISSING)"
	@printf "  npm        %s\n" "$$(npm --version 2>/dev/null || echo MISSING)"
	@if xcodebuild -version >/dev/null 2>&1; then \
		printf "  xcodebuild %s\n" "$$(xcodebuild -version | head -1)"; \
	else \
		printf "  xcodebuild \033[31mMISSING\033[0m — only Command Line Tools (%s), cannot build iOS\n" "$$(xcode-select -p)"; \
	fi
	@printf "  pod        %s\n" "$$(pod --version 2>/dev/null || echo 'MISSING — sudo gem install cocoapods')"
	@printf "\n$(BOLD)deps installed$(OFF)\n"
	@for d in $(API_DIR) $(MOBILE_DIR) $(SHARED_DIR); do \
		printf "  %-18s %s\n" "$$d" "$$([ -d $$d/node_modules ] && echo yes || echo 'no — run make setup')"; done
	@printf "\n$(BOLD)config$(OFF)\n"
	@printf "  LAN IP     %s\n" "$(LAN_IP)"
	@printf "  API_URL    %s\n" "$(API_URL)"
	@printf "  api .env   %s\n" "$$([ -f $(API_DIR)/.env ] && echo present || echo 'absent — see .env.example')"
	@printf "  ios/       %s\n" "$$([ -d $(MOBILE_DIR)/ios ] && echo present || echo 'not generated — created by make ios')"
