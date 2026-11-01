#!/bin/sh
# 公開用の site/ を作る：画面（app）と、図に使う数字（data）
set -e
cd "$(dirname "$0")"
rm -rf site && mkdir -p site/data
cp -r ../app/. site/
cp ../data/index.json site/data/
cp -r ../data/meta site/data/
cp -r ../data/companies site/data/
# 中に残っていても公開しないもの
rm -f site/data/companies/.keep
echo "site/ を作りました：$(ls site/data/companies | wc -l) 社"
