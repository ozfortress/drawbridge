class Functions:
    """
    Drawbridge Helper Functions."""

    def __init__(self):
        pass

    def substitute_strings_in_embed(self, json: dict | list | str, substitutions: dict, depth : int = 0) -> dict | list | str:
        '''
        Recursively substitute strings in a json object

        Parameters
        -----------
        json: dict
            The json object to substitute strings in.
            Accepts list | str as well for recursion, caller should not pass these types.
        substitutions: dict
            The substitutions to make
        depth: int
            The depth of recursion. Used to prevent infinite recursion. Should not be used by the caller.

        Returns
        --------
        dict - The json object with the strings substituted.

        Raises
        -------
        ValueError - If the caller passes a list or str as the first argument.
        '''
        # Recursively substitute strings in a json object
        if depth > 5: # Prevent infinite recursion
            return json
        if depth == 0 and not isinstance(json, dict):
            raise ValueError(f'caller should pass a dict as the first argument, received {type(json)}')
        if isinstance(json, str): #  Self-referenced function to substitute strings in a json object
            for key, value in substitutions.items():
                json = json.replace(key, value)
            return json
        elif isinstance(json, dict):
            for key, value in json.items():
                json[key] = substitute_strings_in_embed(value, substitutions, depth=depth+1)
            return json
        elif isinstance(json, list):
            return [substitute_strings_in_embed(item, substitutions) for item in json]
        else:
            return json
