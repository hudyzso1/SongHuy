CYBERNET AWS BACKEND - BUOC 1

1. Mo PowerShell tai thu muc aws-backend.
2. Lay subnet va security group ID:

$Region = "ap-southeast-1"
$AppSubnetId = aws ec2 describe-subnets --filters "Name=tag:Name,Values=cybernet-private-app-subnet" --query "Subnets[0].SubnetId" --output text --region $Region
$SgId = aws ec2 describe-security-groups --filters "Name=group-name,Values=cybernet-lambda-sg" --query "SecurityGroups[0].GroupId" --output text --region $Region
$AppSubnetId
$SgId

3. Kiem tra va build:

sam validate --lint
sam build

4. Deploy lan dau:

sam deploy --guided

Nhap:
Stack Name: cybernet-cloud-dev
AWS Region: ap-southeast-1
PrivateAppSubnetId: gia tri subnet-...
LambdaSecurityGroupId: gia tri sg-...
AllowedOrigin: *
Confirm changes before deploy: Y
Allow SAM CLI IAM role creation: Y
Disable rollback: N
Save arguments to configuration file: Y
SAM configuration file: samconfig.toml
SAM configuration environment: default

5. Lay URL:

aws cloudformation describe-stacks --stack-name cybernet-cloud-dev --region ap-southeast-1 --query "Stacks[0].Outputs" --output table
