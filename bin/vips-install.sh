#!/usr/bin/env bash
# bin/compile <build-dir> <cache-dir>

function indent() {
  c='s/^/       /'
  case $(uname) in
    Darwin) sed -l "$c";;
    *)      sed -u "$c";;
  esac
}

arrow() {
  sed -u 's/^/-----> /'
}

BUILD_DIR=/app

echo "Installing libvips" | arrow

cd $BUILD_DIR

output_dir="${BUILD_DIR}/vendor/vips"
mkdir -p $output_dir

echo "Downloading libvips and unpacking" | indent
curl -s https://s3-eu-west-1.amazonaws.com/visup-misc/heroku-buildpack-vips/201503311000.tar.gz | tar xz -C $output_dir
if [ $? != 0 ]; then
  echo "Error downloading vips and unpacking to build dir" | indent
  exit 1
fi

mkdir -p $BUILD_DIR/bin/
cp -r $output_dir/bin/* $BUILD_DIR/bin/

echo "libvips installed" | indent