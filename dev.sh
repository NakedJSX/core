#!/bin/bash

rm -rf node_modules package-lock.json
yarn set version stable
yarn install
