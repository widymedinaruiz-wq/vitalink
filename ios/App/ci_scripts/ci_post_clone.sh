#!/bin/zsh
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH"
brew install node
npm ci
npm run build
npx cap sync ios
