#!/bin/sh
# Build the site and publish dist/ to the gh-pages branch of origin (GitHub Pages).
# Detail tiles are baked on this machine from the NASA files in raw/ and are not kept in git, so the
# site is published from here rather than built by GitHub.
# Run: npm run deploy
set -e
url=$(git remote get-url origin)
repo=$(basename "$url" .git)
[ -f public/tiles/manifest.json ] || { echo "No detail tiles found. Run: npm run tiles"; exit 1; }
npm test
npx vite build --base="/$repo/"
touch dist/.nojekyll
commit=$(git rev-parse --short HEAD)
cd dist
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Publish $commit"
git push -f "$url" gh-pages
rm -rf .git
echo "Published $commit to gh-pages"
