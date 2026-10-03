#!/bin/zsh
set -e
cd "$CI_PRIMARY_REPOSITORY_PATH"
brew install node
# Skip dev-only packages: @capacitor/assets pulls in sharp, whose install downloads
# libvips from GitHub and failed build 40 when GitHub returned a 502.
npm ci --omit=dev
npm run build
npx cap sync ios
