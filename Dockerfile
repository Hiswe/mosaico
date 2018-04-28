# Inherit from Heroku's stack (see: https://hub.docker.com/r/heroku/cedar/)
FROM heroku/cedar:14

SHELL ["/bin/bash", "-c"]

#
# Node
#

RUN mkdir -p /app/heroku/node

ENV NODE_ENGINE 8.5.0
RUN curl -s https://s3pository.heroku.com/node/v$NODE_ENGINE/node-v$NODE_ENGINE-linux-x64.tar.gz | tar --strip-components=1 -xz -C /app/heroku/node

RUN mkdir -p /app/.profile.d
RUN echo "export PATH=\"/app/heroku/node/bin:/app/user/node_modules/.bin:\$PATH\"" > /app/.profile.d/nodejs.sh

ENV PATH /app/heroku/node/bin/:/app/user/node_modules/.bin:$PATH

#
# libvips (see: https://github.com/alex88/heroku-buildpack-vips/blob/master/bin/compile)
#

ADD bin/vips-install.sh /tmp/vips-install.sh
RUN cd /tmp && ./vips-install.sh

RUN mkdir -p /app/.profile.d
RUN echo "export PATH=\"\$PATH:/app/vendor/vips/bin\"" > /app/.profile.d/vips.sh
RUN echo "export PKG_CONFIG_PATH=\"\$PKG_CONFIG_PATH:/app/vendor/vips/lib/pkgconfig\"" >> /app/.profile.d/vips.sh
RUN echo "export LD_LIBRARY_PATH=\"\$LD_LIBRARY_PATH:/app/vendor/vips/lib\"" >> /app/.profile.d/vips.sh

ENV PATH $PATH:/app/vendor/vips/bin
ENV PKG_CONFIG_PATH $PKG_CONFIG_PATH:/app/vendor/vips/lib/pkgconfig
ENV LD_LIBRARY_PATH $LD_LIBRARY_PATH:/app/vendor/vips/lib

WORKDIR /app/user

# node_modules (see: http://bitjudo.com/blog/2014/03/13/building-efficient-dockerfiles-node-dot-js/)
ADD package.json /tmp/package.json
RUN echo "PKG_CONFIG_PATH=$PKG_CONFIG_PATH"
RUN echo "LD_LIBRARY_PATH=$LD_LIBRARY_PATH"
RUN cd /tmp && export NODE_ENV=development && npm install
RUN cp -a /tmp/node_modules /app/user

# bower_components
ADD bower.json /tmp/bower.json
RUN cd /tmp && npx bower -V --allow-root install
RUN cp -a /tmp/bower_components /app/user

ADD . /app/user/

RUN npx gulp build

EXPOSE 3000
CMD [ "npm", "start" ]