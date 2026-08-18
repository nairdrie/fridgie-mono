# Fridgie monorepo — local development, device builds, and releases.
#
#   make              list every target, grouped
#   make setup        install everything
#   make api          run the API        (terminal 1)
#   make ios          build + launch the iOS simulator (terminal 2)
#
# Deliberately plain make: this repo is not a package-manager workspace, so
# Turborepo/Nx have nothing to hook into, and make is already on every Mac.

SHELL := /bin/bash
.DEFAULT_GOAL := help

API_DIR    := apps/api
MOBILE_DIR := apps/mobile
SHARED_DIR := packages/shared

API_PORT ?= 3000

# A phone on your wifi cannot reach localhost, so default to the LAN address.
# Simulators and emulators can reach it too, so one value covers every case.
LAN_IP := $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)
API_URL ?= http://$(LAN_IP):$(API_PORT)/api

BUN := $(shell command -v bun 2>/dev/null || echo /opt/homebrew/bin/bun)

# CocoaPods aborts on a non-UTF-8 locale, which is easy to hit in a bare shell.
export LANG ?= en_US.UTF-8

# `xcode-select` commonly points at the Command Line Tools even when Xcode is
# installed, which makes xcodebuild refuse to run. Repointing it needs sudo, so
# rather than demand that, aim DEVELOPER_DIR at Xcode ourselves when we can see
# it. Set DEVELOPER_DIR yourself to override.
XCODE_APP ?= /Applications/Xcode.app
# Captured before the export below, or it would report the value we just set.
XCODE_SELECTED := $(shell xcode-select -p 2>/dev/null)
XCODE_FALLBACK := $(shell if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$(XCODE_APP)/Contents/Developer" ]; \
	then echo "$(XCODE_APP)/Contents/Developer"; fi)
ifneq ($(XCODE_FALLBACK),)
export DEVELOPER_DIR := $(XCODE_FALLBACK)
endif

# Android Studio installs the SDK but never touches your shell, so ANDROID_HOME
# is unset and emulator/ is missing from PATH on a fresh machine. Expo reports
# that as "no emulators could be started automatically", which sends you looking
# at the emulator when the emulator is fine — so point at the SDK ourselves.
# Set ANDROID_HOME yourself to override.
ANDROID_SDK := $(or $(ANDROID_HOME),$(wildcard $(HOME)/Library/Android/sdk))
ifneq ($(ANDROID_SDK),)
export ANDROID_HOME := $(ANDROID_SDK)
export PATH := $(ANDROID_SDK)/emulator:$(ANDROID_SDK)/platform-tools:$(ANDROID_SDK)/cmdline-tools/latest/bin:$(PATH)
endif

# Read from app.json so it cannot drift from what actually gets installed.
APP_ID := $(shell sed -n 's/.*"package": "\(.*\)".*/\1/p' $(MOBILE_DIR)/app.json | head -1)

# Which platform the EAS targets act on: ios | android | all
PLATFORM ?= all

CYAN := \033[36m
DIM  := \033[2m
BOLD := \033[1m
OFF  := \033[0m

# Every target does one thing and owns one process. Run the API in its own
# terminal — nothing here starts it for you.

.PHONY: help
help:
	@printf "$(BOLD)Fridgie$(OFF)   api → $(CYAN)$(API_URL)$(OFF)\n"
	@printf "\n$(DIM)two terminals: 'make api' in one, then a mobile target in the other$(OFF)\n"
	@printf "\n$(BOLD)everyday$(OFF)\n"
	@printf "  $(CYAN)%-18s$(OFF) %s\n" \
		setup            "install dependencies for all three packages" \
		api              "run the API (terminal 1)" \
		dev              "run Metro for the installed dev client (terminal 2)" \
		ios              "build + launch on the iOS simulator" \
		android          "build + launch on the Android emulator"
	@printf "\n$(BOLD)your own phone, over USB$(OFF)\n"
	@printf "  $(CYAN)%-18s$(OFF) %s\n" \
		ios-device       "build + launch on a connected iPhone" \
		android-device   "build + launch on a connected Android"
	@printf "\n$(BOLD)cloud builds (EAS)$(OFF)   add PLATFORM=ios|android|all\n"
	@printf "  $(CYAN)%-18s$(OFF) %s\n" \
		build-dev        "dev client to install on a device (no Xcode needed)" \
		build-preview    "internal test build (APK on Android)" \
		build-prod       "production build for the stores" \
		submit           "submit the latest production build" \
		build-list       "recent EAS builds"
	@printf "\n$(BOLD)quality$(OFF)\n"
	@printf "  $(CYAN)%-18s$(OFF) %s\n" \
		check            "typecheck both apps and run the tests" \
		typecheck        "typecheck both apps" \
		test             "run the API test suite" \
		lint             "lint the mobile app" \
		bundle-check     "verify Metro can bundle"
	@printf "\n$(BOLD)other$(OFF)\n"
	@printf "  $(CYAN)%-18s$(OFF) %s\n" \
		prebuild         "regenerate ios/ and android/ from app.json" \
		docker-build     "build the API image" \
		doctor           "report on the local toolchain" \
		clean            "remove build output and caches" \
		clean-all        "also remove node_modules and native dirs"
	@printf "\n$(DIM)point the app at a different API:  make ios API_URL=http://10.0.0.5:3000/api$(OFF)\n"

# ── setup ────────────────────────────────────────────────────────────────────

.PHONY: setup
setup: check-bun ## Install dependencies for all three packages
	@printf "$(CYAN)==>$(OFF) packages/shared\n"
	@cd $(SHARED_DIR) && npm install --no-audit --no-fund
	@printf "$(CYAN)==>$(OFF) apps/api\n"
	@cd $(API_DIR) && $(BUN) install
	@printf "$(CYAN)==>$(OFF) apps/mobile\n"
	@cd $(MOBILE_DIR) && npm install --no-audit --no-fund
	@printf "\n$(BOLD)Done.$(OFF) Next: cp $(API_DIR)/.env.example $(API_DIR)/.env and fill it in, then 'make ios'.\n"

# ── everyday dev ─────────────────────────────────────────────────────────────

.PHONY: api
api: check-env ## Run the API with live reload (its own terminal)
	@printf "$(CYAN)==>$(OFF) api on :$(API_PORT) — reachable at $(API_URL)\n\n"
	@cd $(API_DIR) && $(BUN) --watch index.ts

.PHONY: dev
dev: ## Run Metro for the installed dev client (its own terminal)
	@printf "$(DIM)app will talk to $(API_URL) — start it with 'make api'$(OFF)\n"
	@# Metro only serves a dev client that is ALREADY installed. Opening it on a
	@# device without one fails as "No development build ... is installed", which
	@# reads like a build problem rather than a missing step, so say so up front.
	@if command -v adb >/dev/null 2>&1 && \
	   [ "$$(adb devices 2>/dev/null | grep -c 'device$$')" != "0" ] && \
	   ! adb shell pm list packages 2>/dev/null | grep -q '$(APP_ID)'; then \
		printf "\033[33mnote:$(OFF) $(APP_ID) is not installed on the attached Android device.\n"; \
		printf "      Metro will start, but opening the app there needs $(BOLD)make android$(OFF) first.\n"; \
	fi
	@printf "\n"
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo start --dev-client

.PHONY: ios
ios: check-xcode ## Build and launch on the iOS simulator
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:ios

.PHONY: android
android: check-android ## Build and launch on the Android emulator
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:android

# ── physical devices, over USB ───────────────────────────────────────────────

.PHONY: ios-device
ios-device: check-xcode ## Build and launch on a connected iPhone
	@printf "$(DIM)Needs the iPhone plugged in, unlocked and trusted. A free Apple ID\n"
	@printf "works but the build expires after 7 days; a paid account lasts a year.$(OFF)\n\n"
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:ios --device

.PHONY: android-device
android-device: check-android ## Build and launch on a connected Android
	@printf "$(DIM)Needs USB debugging on and the device authorised (check: adb devices).$(OFF)\n\n"
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo run:android --device

# ── cloud builds (EAS) ───────────────────────────────────────────────────────
#
# These build on Expo's servers, so they need no local Xcode or Android SDK.
# EAS uploads the whole repo, which is what we want — the app imports
# packages/shared, so an apps/mobile-only archive would not build.

.PHONY: build-dev
build-dev: ## EAS dev-client build to sideload onto a device (PLATFORM=ios|android|all)
	@cd $(MOBILE_DIR) && npx eas-cli build --profile development --platform $(PLATFORM)

.PHONY: build-preview
build-preview: ## EAS internal test build — APK on Android (PLATFORM=...)
	@cd $(MOBILE_DIR) && npx eas-cli build --profile preview --platform $(PLATFORM)

.PHONY: build-prod
build-prod: ## EAS production build for the stores (PLATFORM=...)
	@cd $(MOBILE_DIR) && npx eas-cli build --profile production --platform $(PLATFORM)

.PHONY: submit
submit: ## Submit the latest production build to the stores (PLATFORM=...)
	@cd $(MOBILE_DIR) && npx eas-cli submit --profile production --platform $(PLATFORM)

.PHONY: build-list
build-list: ## Show recent EAS builds
	@cd $(MOBILE_DIR) && npx eas-cli build:list --limit 10

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

# ── other ────────────────────────────────────────────────────────────────────

.PHONY: mobile-go
mobile-go: ## Run Metro in Expo Go mode (most native modules will NOT work)
	@printf "$(DIM)Google Sign-In and other custom native modules are unavailable in Expo Go.$(OFF)\n"
	@cd $(MOBILE_DIR) && EXPO_PUBLIC_API_URL=$(API_URL) npx expo start

.PHONY: prebuild
prebuild: ## Regenerate ios/ and android/ from app.json (discards local edits)
	@cd $(MOBILE_DIR) && npx expo prebuild --clean

.PHONY: docker-build
docker-build: ## Build the API image (context is the repo root, by design)
	docker build -f $(API_DIR)/Dockerfile -t fridgie-api .

.PHONY: clean
clean: ## Remove build output and caches (keeps node_modules)
	@rm -rf $(MOBILE_DIR)/.expo $(MOBILE_DIR)/.expo-export-check $(MOBILE_DIR)/dist
	@rm -rf $(MOBILE_DIR)/ios/build $(MOBILE_DIR)/android/build $(MOBILE_DIR)/android/app/build
	@printf "Cleaned.\n"

.PHONY: clean-all
clean-all: clean ## Also remove node_modules and the generated native projects
	@rm -rf $(API_DIR)/node_modules $(MOBILE_DIR)/node_modules $(SHARED_DIR)/node_modules
	@rm -rf $(MOBILE_DIR)/ios $(MOBILE_DIR)/android
	@printf "Removed node_modules and native dirs. Run 'make setup'.\n"

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
		printf "$(DIM)Continuing anyway — the app will still run, but API calls will fail.$(OFF)\n\n"; \
	fi

.PHONY: check-xcode
check-xcode:
	@if ! xcodebuild -version >/dev/null 2>&1; then \
		printf "\033[31mCannot find a usable Xcode.\033[0m\n\n"; \
		printf "xcode-select points at:  $(XCODE_SELECTED)\n"; \
		printf "and $(XCODE_APP) is not present either.\n\n"; \
		printf "Install Xcode from the App Store, then:\n"; \
		printf "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer\n"; \
		printf "  xcodebuild -runFirstLaunch\n\n"; \
		printf "Or skip local builds: $(BOLD)make build-dev PLATFORM=ios$(OFF) builds a dev\n"; \
		printf "client with EAS to install on a device, then $(BOLD)make dev$(OFF) live-reloads it.\n"; \
		exit 1; \
	fi
	@if [ -n "$(XCODE_FALLBACK)" ]; then \
		printf "$(DIM)note: xcode-select points at $(XCODE_SELECTED), so this build\n"; \
		printf "      uses DEVELOPER_DIR=$(XCODE_FALLBACK) instead.\n"; \
		printf "      To fix it permanently (needs your password):\n"; \
		printf "        sudo xcode-select -s $(XCODE_APP)/Contents/Developer$(OFF)\n\n"; \
	fi
	@command -v pod >/dev/null 2>&1 || { \
		printf "\033[31mCocoaPods is required to build for iOS.\033[0m\n\n  brew install cocoapods\n\n"; exit 1; }

.PHONY: check-android
check-android:
	@if [ -z "$(ANDROID_SDK)" ]; then \
		printf "\033[31mAndroid SDK not found.\033[0m\n\n"; \
		printf "Install Android Studio and open it once to install the SDK.\n"; \
		printf "If it lives somewhere non-standard, set ANDROID_HOME to it.\n\n"; \
		exit 1; \
	fi
	@command -v emulator >/dev/null 2>&1 || { \
		printf "\033[31memulator not found under $(ANDROID_SDK).\033[0m\n\n"; \
		printf "Android Studio > Settings > SDK Manager > SDK Tools > Android Emulator.\n\n"; \
		exit 1; }
	@if [ -z "$$(emulator -list-avds 2>/dev/null)" ] && \
	   [ "$$(adb devices 2>/dev/null | grep -c 'device$$')" = "0" ]; then \
		printf "\033[31mNo Android emulator or device to run on.\033[0m\n\n"; \
		printf "Create a virtual device in Android Studio > Device Manager,\n"; \
		printf "or plug in a phone with USB debugging enabled.\n\n"; \
		exit 1; \
	fi
	@command -v java >/dev/null 2>&1 || { \
		printf "\033[31mA JDK is required to build for Android.\033[0m\n\n"; \
		printf "Android Studio ships one; point JAVA_HOME at it, or:\n"; \
		printf "  brew install --cask temurin\n\n"; exit 1; }

.PHONY: doctor
doctor: ## Report on the local toolchain
	@printf "$(BOLD)shared$(OFF)\n"
	@printf "  bun        %s\n" "$$($(BUN) --version 2>/dev/null || echo 'MISSING — brew install oven-sh/bun/bun')"
	@printf "  node       %s\n" "$$(node --version 2>/dev/null || echo MISSING)"
	@printf "  npm        %s\n" "$$(npm --version 2>/dev/null || echo MISSING)"
	@printf "\n$(BOLD)ios$(OFF)\n"
	@if xcodebuild -version >/dev/null 2>&1; then \
		printf "  xcodebuild %s\n" "$$(xcodebuild -version | head -1)"; \
	else \
		printf "  xcodebuild \033[31mMISSING\033[0m — only Command Line Tools (%s)\n" "$(XCODE_SELECTED)"; \
	fi
	@if [ -n "$(XCODE_FALLBACK)" ]; then \
		printf "  $(DIM)via DEVELOPER_DIR override; sudo xcode-select -s $(XCODE_APP)/Contents/Developer to fix$(OFF)\n"; fi
	@printf "  pod        %s\n" "$$(pod --version 2>/dev/null || echo 'MISSING — brew install cocoapods')"
	@printf "  simulators %s\n" "$$(xcrun simctl list devices available 2>/dev/null | grep -c iPhone || echo 0) iPhone"
	@printf "\n$(BOLD)android$(OFF)\n"
	@if [ -n "$(ANDROID_SDK)" ]; then \
		printf "  sdk        %s\n" "$(ANDROID_SDK)"; \
	else \
		printf "  sdk        \033[31mMISSING\033[0m — install Android Studio\n"; \
	fi
	@if java -version >/dev/null 2>&1; then \
		printf "  java       %s\n" "$$(java -version 2>&1 | head -1)"; \
	else \
		printf "  java       \033[31mMISSING\033[0m — brew install --cask temurin\n"; \
	fi
	@printf "  adb        %s\n" "$$(adb version 2>/dev/null | head -1 || echo '\033[31mMISSING\033[0m — add $$ANDROID_HOME/platform-tools to PATH')"
	@AVDS="$$(emulator -list-avds 2>/dev/null | tr '\n' ' ')"; \
	if [ -n "$$AVDS" ]; then printf "  emulators  %s\n" "$$AVDS"; \
	else printf "  emulators  \033[33mnone\033[0m — create an AVD in Android Studio > Device Manager\n"; fi
	@printf "  devices    %s attached\n" "$$(adb devices 2>/dev/null | grep -c 'device$$' || true)"
	@printf "\n$(BOLD)deps installed$(OFF)\n"
	@for d in $(API_DIR) $(MOBILE_DIR) $(SHARED_DIR); do \
		printf "  %-18s %s\n" "$$d" "$$([ -d $$d/node_modules ] && echo yes || echo 'no — run make setup')"; done
	@printf "\n$(BOLD)config$(OFF)\n"
	@printf "  LAN IP     %s\n" "$(LAN_IP)"
	@printf "  API_URL    %s\n" "$(API_URL)"
	@printf "  api .env   %s\n" "$$([ -f $(API_DIR)/.env ] || [ -f $(API_DIR)/utils/firebase-service-account.json ] && echo present || echo 'absent — see .env.example')"
	@printf "  ios/       %s\n" "$$([ -d $(MOBILE_DIR)/ios ] && echo generated || echo 'not generated — make ios creates it')"
	@printf "  android/   %s\n" "$$([ -d $(MOBILE_DIR)/android ] && echo generated || echo 'not generated — make android creates it')"
