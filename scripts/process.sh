#!/bin/bash

source ./.env

function upload() {
	curl https://api.mistral.ai/v1/files \
	  -H "Authorization: Bearer $MISTRAL_API_KEY" \
	  -F purpose="ocr" \
	  -F file="@${1}"
}

function retrieve() {
	curl -X GET "https://api.mistral.ai/v1/files/${1}/url?expiry=24" \
	 -H "Accept: application/json" \
	 -H "Authorization: Bearer $MISTRAL_API_KEY"
}

function download() {
	
	local URL=$(retrieve "${1}" | jq -rc '.url')
	local OUT="${2:-ocr_output}.json"

	# image_url
	curl https://api.mistral.ai/v1/ocr \
	  -H "Content-Type: application/json" \
	  -H "Authorization: Bearer ${MISTRAL_API_KEY}" \
	  -d '{
		"model": "mistral-ocr-latest",
		"document": {
			"type": "document_url",
			"document_url": "'${URL}'"
		},
		"include_image_base64": true
	  }' -o "${OUT}"

	echo "${OUT}"
}

function delete() {
	curl -X DELETE https://api.mistral.ai/v1/files/${1} \
		-H "Authorization: Bearer ${MISTRAL_API_KEY}"
}

function ocr() {
	#upload "${1}" | jq -rc '.id'
	local FILE_ID="$(upload "${1}" | jq -rc '.id')"
	download "${FILE_ID}"
}

${1} "${2}"
