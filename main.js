import * as THREE from 'three';
import { Text } from 'troika-three-text'; //for Text

const scene = new THREE.Scene(); //Set up scene
//Set up camera: First attribute: field of view in degrees. Second attribute: aspect ratio, almost always width/height. 
//Third and fourth: near and far clipping plane
const camera = new THREE.PerspectiveCamera( 75, window.innerWidth / window.innerHeight, 0.1, 1000 );
const renderer = new THREE.WebGLRenderer(); //Set up renderer
renderer.setSize( window.innerWidth, window.innerHeight ); //Set renderer size: usually width and height of browser window
document.body.appendChild( renderer.domElement ); //Add renderer element to HTML document
//-------------------------------------------------------------
//CUBE
//BoxGeometry is an object that contains all the point (vertices) and fill (faces) of the cube.
const geometry = new THREE.BoxGeometry( 1, 1, 1 ); 
//MeshBasicMaterial that we can add a color attribute in hex to
const material = new THREE.MeshBasicMaterial( { color: 0x00ff00 } );
//A Mesh is an object that takes a geometry and applies material to it.
const cube = new THREE.Mesh( geometry, material );
//Add our Mesh object to the scene. 
scene.add( cube );
//Our Mesh was added at 0,0,0, so we need to move the camera.
camera.position.z = 5;
//-------------------------------------------------------------
//TEXT
const myText = new Text();
scene.add( myText );
myText.text = 'August 2025';
myText.fontSize = 0.25;
myText.position.set(-0.75, 3.5, 0);
myText.color = 0x00ff00;
myText.sync();
//-------------------------------------------------------------
//LINE
//create a blue LineBasicMaterial
const lineMaterial = new THREE.LineBasicMaterial( { color: 0x0000ff } );
//we will need a geometry with some vertices
//lines are drawn between each consecutive pair of vertices, but not between the first and last (the line is not closed.)
const points = [];
points.push( new THREE.Vector3( - 2, 0, 0 ) );
points.push( new THREE.Vector3( 0, 2, 0 ) );
points.push( new THREE.Vector3( 2, 0, 0 ) );

const lineGeometry = new THREE.BufferGeometry().setFromPoints( points );
//Now that we have points for two lines and a material, we can put them together to form a line.
const line = new THREE.Line( lineGeometry, lineMaterial );
scene.add( line );
//-------------------------------------------------------------
//RENDER SCENE
//This creates a loop where the renderer draws the scene everytime the screen is refreshed. 
function animate() {
    cube.rotation.x += 0.01; //MAKE CUBE ROTATE
    cube.rotation.y += 0.01; //MAKE CUBE ROTATE
    renderer.render( scene, camera );
  }
  renderer.setAnimationLoop( animate );
//-------------------------------------------------------------
