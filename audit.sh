#!/bin/bash
rm -rf node_modules .yarn* .pnp.* yarn.lock
npm install
npm audit
