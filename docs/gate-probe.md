---
# yaml-language-server: $schema=../.lore/schemas/reference.schema.json
type: Reference
title: Gate probe
summary: Deliberate violation fixture. Proves the Docs gate rejects a broken cross-link.
---

# Gate probe

This document exists only to be wrong. It links to
[the concept that is not there](./not-a-concept.md), which no document in this
bundle defines, so the cross-link dangles.

It is deliberately valid as a standalone document: `lore validate --strict`
must pass on it, so that the failure it produces is the cross-link pass and not
an earlier one. Two different failures wear the same red, and this fixture is
built to name which one fired.
