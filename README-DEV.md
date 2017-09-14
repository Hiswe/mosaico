
## INSTALL

Pre-requisites:

 - Node.js >=8.5.0
 - [PostgreSQL](https://www.postgresql.org/) >=9.6 ([postgresapp](http://postgresapp.com/) on a mac)
 - [Redis](https://redis.io/) (`brew install redis` on mac `redis-server` to start)
 - SMTP server (like [mailcatcher](https://mailcatcher.me/): `brew install ruby` – restart terminal – `gem install mailcatcher` then `mailcatcher`)

## commands

### building

`npm run build`

### Backoffice tests

#### prerequisite

- all the install's prerequisite
- `pg_restore` installed and present on PATH
- a build done (`npm run build`)
- DB named `mosaico-backend-test`

#### Run all tests:

`npm run tape`

#### Run a specific test:

`npx tape tests/functional/authentification.js | npx faucet`

### DB scripts

**requirements**: `pg_dump` & `pg_restore` installed and present on PATH

`.backendrc` should be provided with *dbConfigs* infos. See `.backendrc-example` for more informations

#### backup-db: backing up to a local folder

- will save a snapshot of the specified DB in the folder defined by `images.tmpDir` config

```
npm run backup-db
```

#### sync-db: syncing a DB from a local folder

- can copy one snapshot saved in `images.tmpDir` DB into another

```
npm run sync-db
```

### S3 notes

There is some script to backup a bucket or sync a bucket from a backup.  
This is mostly use for developement purpose.

#### requirements

- [aws cli](http://docs.aws.amazon.com/cli/latest/reference/) – `brew install awscli` on a mac
- `.backendrc` filled with **s3Configs** parameters. See `.backendrc-example`

[more details about why we use the aws cli](http://stackoverflow.com/questions/17832860/backup-strategies-for-aws-s3-bucket#answer-32927276)

#### backing up to a local folder

```
npm run backup-s3
```

#### syncing a bucket from a local folder

```
npm run sync-s3
```
