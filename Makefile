PROJECT ?= ditc-224715
CONTEXT ?= docker-for-desktop
COMMIT ?= $(shell git rev-parse HEAD)
REF ?= $(shell git branch | grep \* | cut -d ' ' -f2)
ENV_NAME ?= jakub

# Set GitHub Auth Token and Webhook Shared Secret here
GITHUB_TOKEN ?= ""
GITHUB_SHARED_SECRET ?= ""

create-cluster:
	gcloud container clusters create ditc-cluster \
	--project=$(PROJECT) \
	--region=europe-west2-a \
	--image-type=COS \
	--machine-type=n1-standard-2 \
	--num-nodes=1 \
	--node-version=1.10.9-gke.5

configure-helm:
	kubectl --context=$(CONTEXT) create serviceaccount --namespace kube-system tiller
	kubectl --context=$(CONTEXT) create clusterrolebinding tiller-cluster-rule \
	--clusterrole=cluster-admin --serviceaccount=kube-system:tiller
	helm --kube-context=$(CONTEXT) init --service-account tiller

brigade-namespace:
	kubectl --context=$(CONTEXT) apply -f namespaces/brigade.yaml

deploy-brigade:
	helm repo add brigade https://azure.github.io/brigade --kube-context=$(CONTEXT)
	helm upgrade brigade brigade/brigade \
	--install \
	--namespace brigade  \
	--kube-context=$(CONTEXT) \
	--set vacuum.age=72h \
	--set vacuum.maxBuilds=10
	kubectl --context=$(CONTEXT) create clusterrolebinding brigade-worker-cluster-rule \
	--clusterrole=cluster-admin --serviceaccount=brigade:brigade-worker

build-images:
	docker build -t jakubborys/ditc-base:latest -f docker/base.docker .;
	docker build -t jakubborys/ditc-wheel-builder:latest -f docker/build.docker .;
	docker build -t jakubborys/ditc-brigade-worker:latest -f docker/brigade.docker .;

docker-push:
	docker push jakubborys/ditc-base:latest
	docker push jakubborys/ditc-wheel-builder:latest
	docker push jakubborys/ditc-brigade-worker:latest

build: build-images docker-push

build-projects:
	make -C ../ditc-products build
	make -C ../ditc-orders build
	make -C ../ditc-gateway build

# Brigade

install-brigade-deps:
	npm install

lint-brigade:
	./node_modules/.bin/eslint brigade.js

clean-brigade:
	kubectl --context=$(CONTEXT) delete pods -n brigade -l role=vacuum
	kubectl --context=$(CONTEXT) delete pods -n brigade -l component=build
	kubectl --context=$(CONTEXT) delete pods -n brigade -l component=job
	kubectl --context=$(CONTEXT) -n brigade delete secrets \
	$$(kubectl --context=$(CONTEXT) -n brigade get secrets --field-selector=type=brigade.sh/job -o=jsonpath="{.items[*].metadata.name}")
	kubectl --context=$(CONTEXT) -n brigade delete secrets \
	$$(kubectl --context=$(CONTEXT) -n brigade get secrets --field-selector=type=brigade.sh/build -o=jsonpath="{.items[*].metadata.name}")

deploy-projects:
	for project in $(shell ls projects) ; do \
		helm upgrade brigade-$$project charts/brigade-project \
		--install \
		--namespace brigade \
		--kube-context $(CONTEXT) \
		--set sharedSecret=$(GITHUB_SHARED_SECRET) \
		--set github.token=$(GITHUB_TOKEN) \
		-f projects/$$project/values.yaml; \
	done

create-environment:
	cat environment.json | jq '.name = "$(ENV_NAME)" | .action = "create"' > payload.json
	brig run -c $(COMMIT) -r $(REF) -f brigade.js -p payload.json kooba/ditc-config \
	--kube-context $(CONTEXT) --namespace brigade

refresh-environment:
	cat environment.json | jq '.name = "$(ENV_NAME)" | .action = "refresh"' > payload.json
	brig run -c $(COMMIT) -r $(REF) -f brigade.js -p payload.json kooba/ditc-config \
	--kube-context $(CONTEXT) --namespace brigade

delete-environment:
	cat environment.json | jq '.name = "$(ENV_NAME)" | .action = "delete"' > payload.json
	brig run -c $(COMMIT) -r $(REF) -f brigade.js -p payload.json kooba/ditc-config \
	--kube-context $(CONTEXT) --namespace brigade

clean: delete-environment clean-brigade

tp-start:
	telepresence --context $(CONTEXT) --deployment telepresence \
	--namespace jakub --method vpn-tcp

create-products:
	curl 'http://gateway/products' -XPOST -d '{"id": "the_odyssey", "title": "The Odyssey", "passenger_capacity": 101, "maximum_speed": 5, "in_stock": 10}'

get-products:
	curl 'http://gateway/products/the_odyssey'

ksync-init:
	ksync init --context $(CONTEXT)

ksync-setup:
	ksync --context $(CONTEXT) --namespace $(ENV_NAME) create --selector=app=gateway \
	$$(dirname $$(pwd))/ditc-gateway/gateway /appenv/lib/python3.6/site-packages/gateway

ksync-watch:
	ksync watch --context $(CONTEXT)

ksync-get:
	ksync --context $(CONTEXT) get
