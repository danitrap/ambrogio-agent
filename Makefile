SHELL := /bin/bash

SERVICE ?= ambrogio-agent
TAIL ?= 200
MAC_TOOLS_PID_FILE ?= data/runtime/mac-tools-host.pid
MAC_TOOLS_LOG_FILE ?= data/runtime/mac-tools-host.log
MAC_TOOLS_MATCH ?= src/mac-tools/host-main.ts

.PHONY: help install dev start test typecheck \
	compose-build compose-up compose-down compose-restart compose-ps compose-logs \
	mac-tools-host mac-tools-host-start mac-tools-host-stop mac-tools-host-restart mac-tools-host-status \
	dev-ready

help:
	@printf "%-24s %s\n" "install" "Install dependencies with bun"
	@printf "%-24s %s\n" "dev" "Run the agent in development mode"
	@printf "%-24s %s\n" "start" "Run the agent in start mode"
	@printf "%-24s %s\n" "test" "Run Bun tests"
	@printf "%-24s %s\n" "typecheck" "Run TypeScript typecheck"
	@printf "%-24s %s\n" "compose-build" "Build Docker Compose services"
	@printf "%-24s %s\n" "compose-up" "Build and start Docker Compose services"
	@printf "%-24s %s\n" "compose-down" "Stop Docker Compose services"
	@printf "%-24s %s\n" "compose-restart" "Rebuild and restart Docker Compose services"
	@printf "%-24s %s\n" "compose-ps" "Show Docker Compose service status"
	@printf "%-24s %s\n" "compose-logs" "Show Docker Compose logs (TAIL=$(TAIL), SERVICE=$(SERVICE))"
	@printf "%-24s %s\n" "mac-tools-host" "Run mac-tools host in foreground"
	@printf "%-24s %s\n" "mac-tools-host-start" "Start mac-tools host in background"
	@printf "%-24s %s\n" "mac-tools-host-stop" "Stop mac-tools host background process"
	@printf "%-24s %s\n" "mac-tools-host-restart" "Restart mac-tools host background process"
	@printf "%-24s %s\n" "mac-tools-host-status" "Show mac-tools host process status"
	@printf "%-24s %s\n" "dev-ready" "Rebuild Docker, restart mac-tools host, then tail both Docker and mac host logs"

install:
	bun install

dev:
	bun run dev

start:
	bun run start

test:
	bun test

typecheck:
	bun run typecheck

compose-build:
	docker compose build

compose-up:
	docker compose up -d --build

compose-down:
	docker compose down

compose-restart: compose-up

compose-ps:
	docker compose ps

compose-logs:
	docker compose logs --tail=$(TAIL) $(SERVICE)

mac-tools-host:
	bun run mac-tools:host

mac-tools-host-start:
	@mkdir -p "$$(dirname "$(MAC_TOOLS_PID_FILE)")"
	@if [ -f "$(MAC_TOOLS_PID_FILE)" ] && kill -0 "$$(cat "$(MAC_TOOLS_PID_FILE)")" 2>/dev/null; then \
		echo "mac-tools host already running with PID $$(cat "$(MAC_TOOLS_PID_FILE)")"; \
	else \
		rm -f "$(MAC_TOOLS_PID_FILE)"; \
		nohup bun run mac-tools:host >>"$(MAC_TOOLS_LOG_FILE)" 2>&1 & \
		echo $$! > "$(MAC_TOOLS_PID_FILE)"; \
		echo "mac-tools host started with PID $$(cat "$(MAC_TOOLS_PID_FILE)")"; \
		echo "log: $(MAC_TOOLS_LOG_FILE)"; \
	fi

mac-tools-host-stop:
	@if [ -f "$(MAC_TOOLS_PID_FILE)" ] && kill -0 "$$(cat "$(MAC_TOOLS_PID_FILE)")" 2>/dev/null; then \
		kill "$$(cat "$(MAC_TOOLS_PID_FILE)")"; \
		rm -f "$(MAC_TOOLS_PID_FILE)"; \
		echo "mac-tools host stopped"; \
	else \
		PIDS="$$(pgrep -f "$(MAC_TOOLS_MATCH)" || true)"; \
		if [ -n "$$PIDS" ]; then \
			echo "$$PIDS" | xargs kill; \
			rm -f "$(MAC_TOOLS_PID_FILE)"; \
			echo "mac-tools host stopped via process lookup"; \
		else \
			rm -f "$(MAC_TOOLS_PID_FILE)"; \
			echo "mac-tools host is not running"; \
		fi; \
	fi

mac-tools-host-restart: mac-tools-host-stop mac-tools-host-start

mac-tools-host-status:
	@if [ -f "$(MAC_TOOLS_PID_FILE)" ] && kill -0 "$$(cat "$(MAC_TOOLS_PID_FILE)")" 2>/dev/null; then \
		echo "mac-tools host running with PID $$(cat "$(MAC_TOOLS_PID_FILE)")"; \
	elif pgrep -f "$(MAC_TOOLS_MATCH)" >/dev/null 2>&1; then \
		echo "mac-tools host running without PID file:"; \
		pgrep -fl "$(MAC_TOOLS_MATCH)"; \
	else \
		echo "mac-tools host is not running"; \
	fi

dev-ready:
	@mkdir -p "$$(dirname "$(MAC_TOOLS_LOG_FILE)")"
	@touch "$(MAC_TOOLS_LOG_FILE)"
	@$(MAKE) compose-up
	@$(MAKE) mac-tools-host-restart
	@echo "Tailing Docker logs for $(SERVICE) and mac-tools host log. Press Ctrl-C to stop tailing."
	@(docker compose logs -f --tail=$(TAIL) $(SERVICE) & \
	  tail -n $(TAIL) -F "$(MAC_TOOLS_LOG_FILE)" & \
	  wait)
