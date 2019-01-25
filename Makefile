PROJECT ?= ditc-224715
CONTEXT ?= docker-for-desktop
COMMIT ?= $(shell git rev-parse HEAD)
REF ?= $(shell git branch | grep \* | cut -d ' ' -f2)

# Set GitHub Auth Token and Webhook Shared Secret here
GITHUB_TOKEN ?= ""
GITHUB_SHARED_SECRET ?= ""

cluster-create:
	gcloud container clusters create ditc-cluster \
	--project=$(PROJECT) \
	--region=europe-west2-a \
	--zone=europe-west2-a  \
	--image-type=COS \
	--machine-type=n1-standard-1 \
	--num-nodes=1 \
	--node-version=1.10.9-gke.5

cluster-delete:
	gcloud container clusters delete ditc-cluster --region=europe-west2-a

helm:
	kubectl --context=$(CONTEXT) create serviceaccount --namespace kube-system tiller
	kubectl --context=$(CONTEXT) create clusterrolebinding tiller-cluster-rule \
		--clusterrole=cluster-admin --serviceaccount=kube-system:tiller
	kubectl --context=$(CONTEXT) patch deploy --namespace kube-system tiller-deploy \
		-p '{"spec":{"template":{"spec":{"serviceAccount":"tiller"}}}}'
	helm --kube-context=$(CONTEXT) init --service-account tiller --upgrade

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

build-images:
	docker build -t jakubborys/ditc-base:latest -f docker/base.docker .;
	docker build -t jakubborys/ditc-wheel-builder:latest -f docker/build.docker .;
	docker build -t jakubborys/ditc-brigade-worker:latest -f docker/brigade.docker .;

docker-push:
	docker push jakubborys/ditc-brigade-worker:latest

# Brigade

install-brigade-deps:
	npm install

lint-brigade:
	./node_modules/.bin/eslint brigade.js

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
