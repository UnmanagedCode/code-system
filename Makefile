# code-system: convenience targets. The plugin itself needs no make.

ROOT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
PYTHON ?= python3

.PHONY: help agent

help:
	@echo "make agent ARGS='--connect HOST:PORT --remote ID'   run the dial-in agent from this checkout"
	@echo "    (set CODE_SYSTEM_AGENT_SECRET to the remote's secret; PYTHON=$(PYTHON))"

agent:
	@$(PYTHON) "$(ROOT)agent/agent.py" $(ARGS)
