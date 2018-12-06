CONTEXT ?= gke_ditc-224715_europe-west2-a_ditc-cluster

helm:
	kubectl --context=$(CONTEXT) create serviceaccount --namespace kube-system tiller
	kubectl --context=$(CONTEXT) create clusterrolebinding tiller-cluster-rule \
		--clusterrole=cluster-admin --serviceaccount=kube-system:tiller
	kubectl --context=$(CONTEXT) patch deploy --namespace kube-system tiller-deploy \
		-p '{"spec":{"template":{"spec":{"serviceAccount":"tiller"}}}}'
	helm --kube-context=$(CONTEXT) init --service-account tiller --upgrade

brigade-namespace:
	kubectl --context=$(CONTEXT) apply -f k8s/brigade.yaml

deploy-brigade:
	helm repo add brigade https://azure.github.io/brigade --kube-context=$(CONTEXT)
	helm upgrade brigade brigade/brigade \
	--install \
	--namespace brigade  \
	--kube-context=$(CONTEXT) \
	--set vacuum.age=72h \
	--set vacuum.maxBuilds=10

deploy-kashti:
	helm secrets upgrade kashti charts/kashti --install \
	--namespace brigade  \
	--kube-context=$(CONTEXT) \
	-f charts/kashti/secrets.stage.yaml
