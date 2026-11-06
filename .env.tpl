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
AKAHU_APP_TOKEN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/2z24lkruqztbaho7uqoqjjsse4")
# @sensitive @required
AKAHU_USER_TOKEN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/lleillmqnh5ni57dki7edz7wqm")
# @sensitive @required
API_BEARER_TOKEN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/jqjhxjjni6c7nb4iwz2vp7o4hi")
# @sensitive @required
CLOUDFLARE_API_TOKEN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/d6naythanqlr5tpznc4uusqdgq")

# @sensitive @required
ACCESS_APP_HOSTNAME=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/3dxm52aets6a56k74vj7habf7i")
# @sensitive @required
ACCESS_POLICY_AUD=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/izs5fv5uc3gwtrqhn2jteap3ty")
# @sensitive @required
ACCESS_TEAM_DOMAIN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/23b6osmzfojl6bblpdayommjhq")

# @sensitive @required
AKAHU_API_BASE_URL=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/t5qmhl4p7mqui6irefzhvcckwa")
# @required @type=string
API_RATE_LIMIT_PER_MINUTE=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/2qyida4wopighmenp3gxrwgngy")
# @required @type=string
REFRESH_COOLDOWN_SECONDS=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/k4cozn3ao4azwyj6gsym2ex6qa")
# @required @type=string
SYNC_LOOKBACK_DAYS=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/56zvuakscsmjv4ofibg7gwhiie")

# @sensitive @required
CLOUDFLARE_ACCOUNT_ID=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/m3hawifr42jtbhh2a6dx2c5nwy")
# @sensitive @required
CLOUDFLARE_WORKERS_SUBDOMAIN=op("op://i56qshgciuy4cdg4pjrilaeriy/bu5cw4b3uoefkozgtoklyucvfi/66nv6ybjksk2fcto5e7blr2qlm")
