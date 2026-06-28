#!/usr/bin/env python3
"""
Generate the VIGIL Recertification Engine architecture diagram using the
mingrammer `diagrams` library (authentic AWS service icons, rendered via Graphviz).

Output: docs/architecture.png  (overwrites the hand-built PNG)

Run:  python3 docs/generate_architecture.py
"""
from diagrams import Diagram, Cluster, Edge
from diagrams.aws.compute import Lambda
from diagrams.aws.integration import SQS
from diagrams.aws.engagement import SimpleEmailServiceSes as SES
from diagrams.aws.database import Dynamodb
from diagrams.aws.storage import S3
from diagrams.aws.security import Cognito, IAM
from diagrams.aws.network import APIGateway
from diagrams.aws.management import Cloudwatch
from diagrams.aws.general import Users, General
from diagrams.aws.compute import EC2

GRAPH_ATTR = {
    "fontsize": "20",
    "labelloc": "t",
    "label": "VIGIL — Access Recertification Engine",
    "pad": "0.6",
    "splines": "spline",
    "nodesep": "0.7",
    "ranksep": "1.0",
    "bgcolor": "white",
}

with Diagram(
    "",
    filename="docs/architecture",
    outformat="png",
    show=False,
    direction="LR",
    graph_attr=GRAPH_ATTR,
):
    client = Users("Client UI / your app\n(Cognito ID token)")

    with Cluster("Auth"):
        cognito = Cognito("Cognito\nuser pool")

    with Cluster("API"):
        api_gw = APIGateway("API Gateway\n(REST, Cognito authz)")
        api_fn = Lambda("recert-api")

    with Cluster("Discovery & Notify"):
        discovery = Lambda("recert-discovery\n(owner-tag scan)")
        tagging = General("Resource Groups\nTagging API")
        notifier = Lambda("recert-notifier")
        ses = SES("Amazon SES\n(owner emails)")

    with Cluster("Durable enforcement"):
        queue = SQS("Enforcement queue\n(idempotent)")
        dlq = SQS("DLQ")
        alarm = Cloudwatch("CloudWatch alarm")
        enforcer = Lambda("recert-enforcer\nsnapshot -> apply -> verify")

    with Cluster("Resource connectors (scoped)"):
        targets = [
            S3("s3:bucket"),
            IAM("iam:user / role"),
            EC2("ec2:instance"),
        ]

    with Cluster("State & evidence"):
        table = Dynamodb("DynamoDB single table\ncycles / reviews / decisions\nsnapshots / hash-chained evidence")
        evidence = S3("Evidence S3\n(Object Lock / WORM, optional)")

    # Request path
    client >> Edge(label="REST + JWT") >> api_gw >> api_fn
    cognito >> Edge(style="dashed", label="authorize") >> api_gw

    # Discovery / notification
    api_fn >> Edge(label="start cycle") >> discovery
    discovery >> Edge(label="find owner-tagged") >> tagging
    discovery >> Edge(label="trigger") >> notifier >> ses

    # Decision -> enforcement
    api_fn >> Edge(label="enqueue decision") >> queue >> enforcer
    queue >> Edge(style="dashed", label="after N retries") >> dlq >> Edge(style="dashed") >> alarm

    # Enforcement applies scoped change via connectors
    for t in targets:
        enforcer >> Edge(label="apply change") >> t

    # Persistence + evidence
    api_fn >> Edge(style="dashed") >> table
    enforcer >> Edge(label="status + evidence") >> table
    enforcer >> Edge(style="dashed", label="WORM mirror") >> evidence
