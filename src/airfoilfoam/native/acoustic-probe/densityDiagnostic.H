#include <cmath>
#include <iomanip>
#include <iostream>

void reportDensityReconstruction
(
    const Foam::fvMesh& mesh,
    const Foam::volScalarField& density,
    const Foam::volScalarField& pressure,
    const Foam::volScalarField& temperature,
    const Foam::surfaceScalarField& forward,
    const Foam::surfaceScalarField& backward
)
{
    auto entry = [](const char* name, Foam::scalar value)
    {
        std::cout << ",\"" << name << "\":";
        if (std::isfinite(value)) std::cout << value;
        else std::cout << "null";
    };
    auto internal = [&](const Foam::surfaceScalarField& field, const char* direction)
    {
        const Foam::label face = Foam::findMin(field.primitiveField());
        const Foam::label owner = mesh.faceOwner()[face];
        const Foam::label neighbour = mesh.faceNeighbour()[face];
        std::cout << std::setprecision(17) << "XFOILFOAM_DENSITY_RECONSTRUCTION {\"kind\":\"internal\",\"direction\":\""
            << direction << "\",\"face\":" << face << ",\"owner\":" << owner << ",\"neighbour\":" << neighbour;
        entry("face_density", field[face]);
        entry("owner_density", density[owner]);
        entry("neighbour_density", density[neighbour]);
        entry("owner_pressure", pressure[owner]);
        entry("neighbour_pressure", pressure[neighbour]);
        entry("owner_temperature", temperature[owner]);
        entry("neighbour_temperature", temperature[neighbour]);
        entry("x", mesh.Cf()[face].x());
        entry("y", mesh.Cf()[face].y());
        entry("minimum_cell_density", Foam::gMin(density.primitiveField()));
        std::cout << "}" << std::endl;
    };
    internal(forward, "forward");
    internal(backward, "backward");
    const auto& velocity = mesh.lookupObject<Foam::volVectorField>("U");
    const auto& momentum = mesh.lookupObject<Foam::volVectorField>("rhoU");
    auto velocityState = [&](const Foam::surfaceScalarField& densityFace, const char* directionName)
    {
        const auto& direction = mesh.lookupObject<Foam::surfaceScalarField>(directionName);
        const Foam::surfaceVectorField conservativeVelocity(Foam::interpolate(momentum, direction, velocity.name())/densityFace);
        const Foam::surfaceVectorField primitiveVelocity(Foam::interpolate(velocity, direction));
        const Foam::scalarField speed(Foam::mag(conservativeVelocity.primitiveField()));
        const Foam::label face = Foam::findMax(speed);
        std::cout << "XFOILFOAM_DENSITY_RECONSTRUCTION {\"kind\":\"velocity\",\"direction\":\"" << directionName
            << "\",\"face\":" << face;
        entry("conservative_speed", speed[face]);
        entry("primitive_speed", Foam::mag(primitiveVelocity[face]));
        entry("maximum_cell_speed", Foam::gMax(Foam::mag(velocity.primitiveField())));
        entry("face_density", densityFace[face]);
        entry("owner_density", density[mesh.faceOwner()[face]]);
        entry("neighbour_density", density[mesh.faceNeighbour()[face]]);
        entry("x", mesh.Cf()[face].x());
        entry("y", mesh.Cf()[face].y());
        std::cout << "}" << std::endl;
    };
    velocityState(forward, "pos");
    velocityState(backward, "neg");
    forAll(mesh.boundary(), patchIndex)
    {
        const auto& patch = mesh.boundary()[patchIndex];
        if (!forward.boundaryField()[patchIndex].size()) continue;
        std::cout << "XFOILFOAM_DENSITY_RECONSTRUCTION {\"kind\":\"boundary\",\"patch\":\"" << patch.name()
            << "\",\"type\":\"" << patch.type() << "\",\"faces\":" << patch.size();
        entry("minimum_forward_density", Foam::gMin(forward.boundaryField()[patchIndex]));
        entry("minimum_backward_density", Foam::gMin(backward.boundaryField()[patchIndex]));
        entry("minimum_cell_density", Foam::gMin(density.boundaryField()[patchIndex]));
        entry("minimum_pressure", Foam::gMin(pressure.boundaryField()[patchIndex]));
        entry("minimum_temperature", Foam::gMin(temperature.boundaryField()[patchIndex]));
        std::cout << "}" << std::endl;
    }
}
