# Varlock schema and environment template. These references target the
# BankGlass item in the github-actions vault.
# @plugin(@varlock/1password-plugin)
# @initOp(token=$OP_TOKEN, allowAppAuth=true)
# @defaultRequired=false
# @defaultSensitive=false
# ---

# @type=opServiceAccountToken @internal
OP_TOKEN=

# @type=enum(dev, prod) @required
STAGE=dev

# @sensitive @required
AKAHU_APP_TOKEN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/eieej6gi2q4m6okzog5rb3ey3y/AKAHU_APP_TOKEN")
# @sensitive @required
AKAHU_USER_TOKEN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/eieej6gi2q4m6okzog5rb3ey3y/AKAHU_USER_TOKEN")
# @sensitive @required
API_BEARER_TOKEN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/eieej6gi2q4m6okzog5rb3ey3y/API_BEARER_TOKEN")
# @sensitive @required
CLOUDFLARE_API_TOKEN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/eieej6gi2q4m6okzog5rb3ey3y/CLOUDFLARE_API_TOKEN")

# @sensitive @required
ACCESS_APP_HOSTNAME=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/hpp7njpbc6clbnssk6xwa33cry/ACCESS_APP_HOSTNAME")
# @sensitive @required
ACCESS_POLICY_AUD=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/hpp7njpbc6clbnssk6xwa33cry/ACCESS_POLICY_AUD")
# @sensitive @required
ACCESS_TEAM_DOMAIN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/hpp7njpbc6clbnssk6xwa33cry/ACCESS_TEAM_DOMAIN")

# @sensitive @required
AKAHU_API_BASE_URL=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/n3izjkeutt67ik74gzvqxndjfy/AKAHU_API_BASE_URL")
# @required @type=string
API_RATE_LIMIT_PER_MINUTE=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/n3izjkeutt67ik74gzvqxndjfy/API_RATE_LIMIT_PER_MINUTE")
# @required @type=string
REFRESH_COOLDOWN_SECONDS=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/n3izjkeutt67ik74gzvqxndjfy/REFRESH_COOLDOWN_SECONDS")
# @required @type=string
SYNC_LOOKBACK_DAYS=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/n3izjkeutt67ik74gzvqxndjfy/SYNC_LOOKBACK_DAYS")

# @sensitive @required
CLOUDFLARE_ACCOUNT_ID=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/gofpfzqqgo2756hbdlz6nm6nry/CLOUDFLARE_ACCOUNT_ID")
# @sensitive @required
CLOUDFLARE_WORKERS_SUBDOMAIN=op("op://uhub4xx3iwwsaxj3robdosm2hu/zqaspv4bzqoqrfqklsiemgique/66nv6ybjksk2fcto5e7blr2qlm")
