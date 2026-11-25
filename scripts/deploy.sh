#!/bin/sh
# Build the site and publish it to the gh-pages branch of origin (GitHub Pages).
# Detail tiles are baked on this machine from the NASA files in raw/ and are not kept in git, so the
# site is published from here rather than built by GitHub.
# Run: npm run deploy
set -e
url=$(git remote get-url origin)
repo=$(basename "$url" .git)
[ -f public/tiles/manifest.json ] || { echo "No detail tiles found. Run: npm run tiles"; exit 1; }
npm test
# Built into its own folder so the local build in dist/ keeps working at the site root.
npx vite build --base="/$repo/" --outDir .deploy --emptyOutDir
touch .deploy/.nojekyll
commit=$(git rev-parse --short HEAD)
cd .deploy
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Publish $commit"
git push -f "$url" gh-pages
rm -rf .git
echo "Published $commit to gh-pages"
