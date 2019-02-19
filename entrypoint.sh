#!/bin/bash
#find genes/* -maxdepth 3 -name package.json -execdir npm install \;
echo "# Inheriting package.json...."
node /app/merge /app
echo "# npm install..."
npm install
echo "# Starting Planarium......."
node index.js
