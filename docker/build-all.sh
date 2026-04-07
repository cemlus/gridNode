# run in root folder
set -e

REGISTRY="siddhantbh"
TAG="latest"

images=("ml-base" "video" "server-runner" "data-processing")

for image in "${images[@]}"; do
    echo "Building $image..."
    
    IMAGE_NAME="gridnode-$image"
    
    docker build -t $REGISTRY/$IMAGE_NAME:$TAG ./docker/$image/
    docker push $REGISTRY/$IMAGE_NAME:$TAG
    
    echo "Pushed $REGISTRY/$IMAGE_NAME:$TAG"
done

echo "Building ml-gpu..."
docker build -t $REGISTRY/gridnode-ml-gpu:$TAG ./docker/ml-gpu/
docker push $REGISTRY/gridnode-ml-gpu:$TAG